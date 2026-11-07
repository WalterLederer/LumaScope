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
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }

    $complete = $true
    foreach ($relativePath in $requiredSourceFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate $relativePath) -PathType Leaf)) {
            $complete = $false
            break
        }
    }
    if (-not $complete) { continue }

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

$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null

function Sync-ResourceDirectory {
    param([string]$Name)

    $from = Join-Path $source $Name
    $to = Join-Path $destinationPath $Name

    if (Test-Path -LiteralPath $from -PathType Container) {
        New-Item -ItemType Directory -Path $to -Force | Out-Null

        # Robocopy compares size and timestamp and transfers only changed/new
        # files. /MIR also removes files deleted from the SDK. Exit codes 0-7
        # are successful Robocopy result states; 8+ indicate a copy failure.
        & robocopy.exe $from $to /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /NFL /NDL /NJH /NJS
        $code = $LASTEXITCODE
        if ($code -ge 8) {
            throw "OsmAnd resource synchronization failed for '$Name' (robocopy exit code $code)."
        }
    } elseif (Test-Path -LiteralPath $to) {
        Remove-Item -LiteralPath $to -Recurse -Force
    }
}

foreach ($directoryName in @('rendering_styles', 'poi', 'routing', 'misc')) {
    Sync-ResourceDirectory -Name $directoryName
}

$licenseDestination = Join-Path $destinationPath 'licenses'
New-Item -ItemType Directory -Path $licenseDestination -Force | Out-Null
Copy-Item -LiteralPath $upstreamLicense -Destination (Join-Path $licenseDestination 'OSMAND-RESOURCES-LICENSE.txt') -Force
foreach ($licenseName in @('GPL-3.0.txt', 'ICU-DATA-LICENSE.txt')) {
    Copy-Item -LiteralPath (Join-Path $licenseSource $licenseName) -Destination $licenseDestination -Force
}
Copy-Item -LiteralPath $noticeSource -Destination (Join-Path $destinationPath 'NOTICE.md') -Force

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
    if (-not (Test-Path -LiteralPath (Join-Path $destinationPath $relativePath) -PathType Leaf)) {
        throw "OsmAnd resource staging verification failed: $relativePath"
    }
}
foreach ($relativePath in $requiredSourceDirectories) {
    $directory = Join-Path $destinationPath $relativePath
    if (-not (Test-Path -LiteralPath $directory -PathType Container) -or
        @(Get-ChildItem -LiteralPath $directory -File -Recurse -Force).Count -eq 0) {
        throw "OsmAnd renderer assets are missing or empty: $relativePath"
    }
}

$styleCount = @(Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles') -File -Filter '*.render.xml' -Recurse).Count
$fontCount = @(Get-ChildItem -LiteralPath (Join-Path $destinationPath 'rendering_styles') -File -Filter '*.ttf' -Recurse).Count
$assetFiles = @(Get-ChildItem -LiteralPath $destinationPath -File -Recurse -Force)
$totalBytes = ($assetFiles | Measure-Object -Property Length -Sum).Sum

Write-Host 'OsmAnd renderer resources synchronized incrementally:'
Write-Host "  SDK root:      $sdkRootResolved"
Write-Host "  Source:        $source"
Write-Host "  Destination:   $destinationPath"
Write-Host "  Styles:        $styleCount"
Write-Host "  Fonts:         $fontCount"
Write-Host "  Runtime files: $($assetFiles.Count)"
Write-Host "  Runtime size:  $([math]::Round($totalBytes / 1MB, 2)) MiB"
