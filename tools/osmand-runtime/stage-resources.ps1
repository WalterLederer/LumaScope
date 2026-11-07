#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$SdkRoot = $(if ($env:LUMASCOPE_OSMAND_SDK_ROOT) {
        $env:LUMASCOPE_OSMAND_SDK_ROOT
    } else {
        Join-Path $PSScriptRoot '..\..\..\OsmAnd-SDK'
    }),
    [string]$Destination = (Join-Path $PSScriptRoot 'stage\resources')
)

$ErrorActionPreference = 'Stop'

$sdkRootResolved = (Resolve-Path -LiteralPath $SdkRoot).Path

# Prefer the complete vendored OsmAnd resource tree used by this SDK.
# Fallback roots are accepted only when they contain the complete renderer
# resource layout, not merely a rendering_styles directory.
$candidateRoots = @(
    (Join-Path $sdkRootResolved 'vendor\osmand\resources'),
    (Join-Path $sdkRootResolved 'resources'),
    (Join-Path $sdkRootResolved 'OsmAnd-resources\resources'),
    (Join-Path $sdkRootResolved 'OsmAnd-resources')
)

$requiredSourceFiles = @(
    'rendering_styles\default.render.xml',
    'rendering_styles\fonts\LICENSE.txt',
    'poi\poi_types.xml',
    'routing\routing.xml'
)
$requiredSourceDirectories = @(
    'rendering_styles\style-icons\map-icons-svg',
    'rendering_styles\style-icons\map-shaders-svg',
    'rendering_styles\stubs'
)

$source = $null
foreach ($candidate in $candidateRoots) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        continue
    }

    $complete = $true
    foreach ($relativePath in $requiredSourceFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate $relativePath) -PathType Leaf)) {
            $complete = $false
            break
        }
    }
    if (-not $complete) {
        continue
    }

    foreach ($relativePath in $requiredSourceDirectories) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate $relativePath) -PathType Container)) {
            $complete = $false
            break
        }
    }
    if ($complete) {
        $source = [IO.Path]::GetFullPath($candidate)
        break
    }
}

if (-not $source) {
    throw "No complete OsmAnd renderer resource tree found below SDK root: $sdkRootResolved"
}

$styleSource = Join-Path $source 'rendering_styles'
$fontLicense = Join-Path $styleSource 'fonts\LICENSE.txt'
$upstreamLicense = Join-Path $source 'LICENSE'
if (-not (Test-Path -LiteralPath $upstreamLicense -PathType Leaf)) {
    throw "OsmAnd resources LICENSE not found: $upstreamLicense"
}

$licenseSource = Join-Path $PSScriptRoot 'licenses'
foreach ($licenseName in @('GPL-3.0.txt', 'ICU-DATA-LICENSE.txt')) {
    $licensePath = Join-Path $licenseSource $licenseName
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "LumaScope license notice is missing: $licensePath"
    }
}
$noticeSource = Join-Path $PSScriptRoot 'OSMAND-RESOURCES-NOTICE.md'
if (-not (Test-Path -LiteralPath $noticeSource -PathType Leaf)) {
    throw "OsmAnd resources notice is missing: $noticeSource"
}

# Stage beside the destination. The existing runtime tree is left untouched
# until the new tree has been copied and verified in full.
$destinationPath = [IO.Path]::GetFullPath($Destination)
$destinationParent = Split-Path -Parent $destinationPath
New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null

$stagingPath = Join-Path $destinationParent ('.resources-stage-' + [guid]::NewGuid().ToString('N'))
$backupPath = Join-Path $destinationParent ('.resources-backup-' + [guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null

    # Copy the complete rendering resource tree, including all map/POI icons,
    # shields, shaders, density variants, stubs, styles and font subdirectories.
    Copy-Item -LiteralPath $styleSource -Destination $stagingPath -Recurse -Force

    # These resource groups are consumed by the renderer or exposed through
    # the OsmAnd Core resource provider. Preserve their complete subtrees.
    foreach ($directoryName in @('poi', 'routing', 'misc')) {
        $sourceDirectory = Join-Path $source $directoryName
        if (Test-Path -LiteralPath $sourceDirectory -PathType Container) {
            Copy-Item -LiteralPath $sourceDirectory -Destination $stagingPath -Recurse -Force
        }
    }

    $licenseDestination = Join-Path $stagingPath 'licenses'
    New-Item -ItemType Directory -Path $licenseDestination -Force | Out-Null
    Copy-Item -LiteralPath $upstreamLicense -Destination (Join-Path $licenseDestination 'OSMAND-RESOURCES-LICENSE.txt') -Force
    foreach ($licenseName in @('GPL-3.0.txt', 'ICU-DATA-LICENSE.txt')) {
        Copy-Item -LiteralPath (Join-Path $licenseSource $licenseName) -Destination $licenseDestination -Force
    }
    Copy-Item -LiteralPath $noticeSource -Destination (Join-Path $stagingPath 'NOTICE.md') -Force

    $requiredStagedFiles = @(
        'rendering_styles\default.render.xml',
        'rendering_styles\fonts\LICENSE.txt',
        'poi\poi_types.xml',
        'routing\routing.xml',
        'licenses\OSMAND-RESOURCES-LICENSE.txt',
        'licenses\GPL-3.0.txt',
        'licenses\ICU-DATA-LICENSE.txt',
        'NOTICE.md'
    )
    foreach ($relativePath in $requiredStagedFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagingPath $relativePath) -PathType Leaf)) {
            throw "OsmAnd resource staging verification failed: $relativePath"
        }
    }

    foreach ($relativePath in $requiredSourceDirectories) {
        $stagedRelativePath = $relativePath
        $directory = Join-Path $stagingPath $stagedRelativePath
        if (-not (Test-Path -LiteralPath $directory -PathType Container) -or
            @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force).Count -eq 0) {
            throw "OsmAnd renderer assets are missing or empty: $stagedRelativePath"
        }
    }

    # Verify every copied runtime resource by relative path and byte length.
    # This detects incomplete copies before the current staged tree is swapped.
    $sourceFiles = @()
    foreach ($directoryName in @('rendering_styles', 'poi', 'routing', 'misc')) {
        $sourceDirectory = Join-Path $source $directoryName
        if (Test-Path -LiteralPath $sourceDirectory -PathType Container) {
            $sourceFiles += Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse -Force
        }
    }
    $stagedFiles = @()
    foreach ($directoryName in @('rendering_styles', 'poi', 'routing', 'misc')) {
        $stagedDirectory = Join-Path $stagingPath $directoryName
        if (Test-Path -LiteralPath $stagedDirectory -PathType Container) {
            $stagedFiles += Get-ChildItem -LiteralPath $stagedDirectory -File -Recurse -Force
        }
    }

    $sourceManifest = @{}
    foreach ($file in $sourceFiles) {
        $relativePath = [IO.Path]::GetRelativePath($source, $file.FullName)
        $sourceManifest[$relativePath] = [long]$file.Length
    }
    $stagedManifest = @{}
    foreach ($file in $stagedFiles) {
        $relativePath = [IO.Path]::GetRelativePath($stagingPath, $file.FullName)
        $stagedManifest[$relativePath] = [long]$file.Length
    }

    $missing = @($sourceManifest.Keys | Where-Object { -not $stagedManifest.ContainsKey($_) })
    $unexpected = @($stagedManifest.Keys | Where-Object { -not $sourceManifest.ContainsKey($_) })
    $differentSize = @($sourceManifest.Keys | Where-Object {
        $stagedManifest.ContainsKey($_) -and $sourceManifest[$_] -ne $stagedManifest[$_]
    })
    if ($missing.Count -gt 0 -or $unexpected.Count -gt 0 -or $differentSize.Count -gt 0) {
        throw "OsmAnd resource copy verification failed. Missing=$($missing.Count), unexpected=$($unexpected.Count), sizeMismatch=$($differentSize.Count)"
    }

    # Swap only after the new tree is complete. If the rename fails, restore
    # the previous destination rather than leaving the runtime without resources.
    if (Test-Path -LiteralPath $destinationPath) {
        Move-Item -LiteralPath $destinationPath -Destination $backupPath
    }
    try {
        Move-Item -LiteralPath $stagingPath -Destination $destinationPath
    } catch {
        if (Test-Path -LiteralPath $backupPath) {
            if (Test-Path -LiteralPath $destinationPath) {
                [IO.Directory]::Delete($destinationPath, $true)
            }
            Move-Item -LiteralPath $backupPath -Destination $destinationPath
        }
        throw
    }

    if (Test-Path -LiteralPath $backupPath) {
        [IO.Directory]::Delete($backupPath, $true)
    }

    $styleCount = @(Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles') -File -Filter '*.render.xml' -Recurse).Count
    $fontCount = @(Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles') -File -Filter '*.ttf' -Recurse).Count
    $assetCount = $stagedFiles.Count
    $totalBytes = ($stagedFiles | Measure-Object -Property Length -Sum).Sum

    Write-Host 'OsmAnd renderer resources staged (complete runtime asset trees):'
    Write-Host "  SDK root:    $sdkRootResolved"
    Write-Host "  Source:      $source"
    Write-Host "  Destination: $destinationPath"
    Write-Host "  Styles:      $styleCount"
    Write-Host "  Fonts:       $fontCount"
    Write-Host "  Runtime files: $assetCount"
    Write-Host "  Runtime size:  $([math]::Round($totalBytes / 1MB, 2)) MiB"
    Write-Host '  Map icon SVGs:    ' (Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles\style-icons\map-icons-svg') -File -Recurse).Count
    Write-Host '  Shader SVGs:      ' (Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles\style-icons\map-shaders-svg') -File -Recurse).Count
    Write-Host '  Rendering stubs:  ' (Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles\stubs') -File -Recurse).Count
} finally {
    if (Test-Path -LiteralPath $stagingPath) {
        [IO.Directory]::Delete($stagingPath, $true)
    }
    if (Test-Path -LiteralPath $backupPath) {
        # A backup remains only if an earlier swap/cleanup was interrupted.
        # Never delete it automatically on failure.
        Write-Warning "Previous resource staging backup retained at: $backupPath"
    }
}
