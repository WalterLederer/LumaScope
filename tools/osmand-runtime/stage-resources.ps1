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

# SDK snapshots do not all use the same top-level layout. Prefer known locations,
# then discover a rendering_styles directory below the supplied SDK root.
$candidateRoots = @(
    (Join-Path $sdkRootResolved 'vendor\\osmand\\resources'),
    (Join-Path $sdkRootResolved 'resources'),
    (Join-Path $sdkRootResolved 'OsmAnd-resources'),
    (Join-Path $sdkRootResolved 'OsmAnd-resources\\resources')
)
$styleDirectories = @()
foreach ($candidate in $candidateRoots) {
    $candidateStyles = Join-Path $candidate 'rendering_styles'
    if (Test-Path -LiteralPath $candidateStyles -PathType Container) {
        $styleDirectories += Get-Item -LiteralPath $candidateStyles
    }
}
if ($styleDirectories.Count -eq 0) {
    $styleDirectories = @(Get-ChildItem -LiteralPath $sdkRootResolved -Directory -Filter 'rendering_styles' -Recurse -ErrorAction SilentlyContinue)
}
$styleDirectory = $styleDirectories |
    Where-Object {
        @(Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.render.xml' -ErrorAction SilentlyContinue).Count -gt 0
    } |
    Select-Object -First 1
if (-not $styleDirectory) {
    throw "No OsmAnd rendering_styles directory with .render.xml files found below SDK root: $sdkRootResolved"
}

$source = $styleDirectory.Parent.FullName
$styleSource = $styleDirectory.FullName
$availableStyles = @(Get-ChildItem -LiteralPath $styleSource -File -Filter '*.render.xml' |
    Where-Object {
        $_.Name -notlike '*.addon.render.xml' -and
        $_.Name -notin @('standalone-template.render.xml', 'template.addon.render.xml')
    })
if ($availableStyles.Count -eq 0) {
    throw "No redistributable OsmAnd rendering styles were found in: $styleSource"
}

$fontSource = Join-Path $styleSource 'fonts'
$fontFiles = if (Test-Path -LiteralPath $fontSource -PathType Container) {
    @(Get-ChildItem -LiteralPath $fontSource -File -Filter '*.ttf')
} else { @() }
$fontLicense = Join-Path $fontSource 'LICENSE.txt'
if (-not (Test-Path -LiteralPath $fontLicense -PathType Leaf)) {
    throw "OsmAnd rendering font license not found: $fontLicense"
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
if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force
}

$styleDestination = Join-Path $destinationPath 'rendering_styles'
$fontDestination = Join-Path $styleDestination 'fonts'
$poiDestination = Join-Path $destinationPath 'poi'
$routingDestination = Join-Path $destinationPath 'routing'
$icuDestination = Join-Path $destinationPath 'misc\icu4c'
$licenseDestination = Join-Path $destinationPath 'licenses'

New-Item -ItemType Directory -Path $styleDestination, $fontDestination, $poiDestination, $routingDestination, $icuDestination, $licenseDestination -Force | Out-Null

# Text styles are GPLv3 according to the OsmAnd maintainer clarification.
Get-ChildItem -LiteralPath $styleSource -File -Filter '*.render.xml' |
    Where-Object {
        $_.Name -notlike '*.addon.render.xml' -and
        $_.Name -notin @('standalone-template.render.xml', 'template.addon.render.xml')
    } |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $styleDestination -Force
    }

# The active fonts directory carries its own Apache-2.0 license.
$fontFiles |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $fontDestination -Force
    }
Copy-Item -LiteralPath $fontLicense -Destination $fontDestination -Force

# Auxiliary resource files are copied when present in this SDK snapshot.
$optionalFiles = @(
    @{ Relative = 'poi\poi_types.xml'; Destination = $poiDestination },
    @{ Relative = 'routing\routing.xml'; Destination = $routingDestination },
    @{ Relative = 'misc\icu4c\icudt52l.dat'; Destination = $icuDestination }
)
foreach ($item in $optionalFiles) {
    $optionalPath = Join-Path $source $item.Relative
    if (Test-Path -LiteralPath $optionalPath -PathType Leaf) {
        Copy-Item -LiteralPath $optionalPath -Destination $item.Destination -Force
    }
}

$upstreamLicenseCandidates = @(
    (Join-Path $source 'LICENSE'),
    (Join-Path $sdkRootResolved 'LICENSE'),
    (Join-Path (Split-Path -Parent $source) 'LICENSE')
)
$upstreamLicense = $upstreamLicenseCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $upstreamLicense) {
    throw "Could not locate the upstream OsmAnd resources LICENSE under SDK root: $sdkRootResolved"
}
Copy-Item -LiteralPath $upstreamLicense -Destination (Join-Path $licenseDestination 'OSMAND-RESOURCES-LICENSE.txt') -Force

foreach ($licenseName in @('GPL-3.0.txt', 'ICU-DATA-LICENSE.txt')) {
    Copy-Item -LiteralPath (Join-Path $licenseSource $licenseName) -Destination $licenseDestination -Force
}
Copy-Item -LiteralPath $noticeSource -Destination (Join-Path $destinationPath 'NOTICE.md') -Force

$verification = @(
    'rendering_styles\fonts\LICENSE.txt',
    'licenses\GPL-3.0.txt',
    'licenses\ICU-DATA-LICENSE.txt',
    'licenses\OSMAND-RESOURCES-LICENSE.txt',
    'NOTICE.md'
)
foreach ($relativePath in $verification) {
    $path = Join-Path $destinationPath $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "OsmAnd resource staging verification failed: $path"
    }
}
$stagedStyles = @(Get-ChildItem -LiteralPath $styleDestination -File -Filter '*.render.xml')
$stagedFonts = @(Get-ChildItem -LiteralPath $fontDestination -File -Filter '*.ttf')
if ($stagedStyles.Count -eq 0) {
    throw "OsmAnd resource staging verification found no rendering styles: $styleDestination"
}
if ($stagedFonts.Count -eq 0) {
    throw "OsmAnd resource staging verification found no TTF fonts: $fontDestination"
}

$styleCount = (Get-ChildItem -LiteralPath $styleDestination -File -Filter '*.render.xml').Count
$fontCount = (Get-ChildItem -LiteralPath $fontDestination -File -Filter '*.ttf').Count
$fileCount = (Get-ChildItem -LiteralPath $destinationPath -File -Recurse).Count
$totalBytes = (Get-ChildItem -LiteralPath $destinationPath -File -Recurse | Measure-Object -Property Length -Sum).Sum

Write-Host 'OsmAnd resources staged (license-cleared whitelist):'
Write-Host "  SDK root:    $sdkRootResolved"
Write-Host "  Source:      $source"
Write-Host "  Destination: $destinationPath"
Write-Host "  Styles:      $styleCount"
Write-Host "  Fonts:       $fontCount"
Write-Host "  Files:       $fileCount"
Write-Host "  Size:        $([math]::Round($totalBytes / 1MB, 2)) MiB"
Write-Host '  Graphics:    excluded pending per-asset license verification'
