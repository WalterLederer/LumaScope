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
$source = Join-Path $sdkRootResolved 'vendor\osmand\resources'
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "OsmAnd resource source directory not found: $source"
}

$requiredSources = @(
    'rendering_styles\default.render.xml',
    'rendering_styles\fonts\LICENSE.txt',
    'poi\poi_types.xml',
    'routing\routing.xml',
    'misc\icu4c\icudt52l.dat',
    'LICENSE'
)
foreach ($relativePath in $requiredSources) {
    $path = Join-Path $source $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required OsmAnd resource is missing: $path"
    }
}

$styleSource = Join-Path $source 'rendering_styles'
$fontSource = Join-Path $styleSource 'fonts'
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
Get-ChildItem -LiteralPath $fontSource -File -Filter '*.ttf' |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $fontDestination -Force
    }
Copy-Item -LiteralPath (Join-Path $fontSource 'LICENSE.txt') -Destination $fontDestination -Force

Copy-Item -LiteralPath (Join-Path $source 'poi\poi_types.xml') -Destination $poiDestination -Force
Copy-Item -LiteralPath (Join-Path $source 'routing\routing.xml') -Destination $routingDestination -Force
Copy-Item -LiteralPath (Join-Path $source 'misc\icu4c\icudt52l.dat') -Destination $icuDestination -Force
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $licenseDestination 'OSMAND-RESOURCES-LICENSE.txt') -Force

$licenseSource = Join-Path $PSScriptRoot 'licenses'
foreach ($licenseName in @('GPL-3.0.txt', 'ICU-DATA-LICENSE.txt')) {
    $licensePath = Join-Path $licenseSource $licenseName
    if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
        throw "LumaScope license notice is missing: $licensePath"
    }
    Copy-Item -LiteralPath $licensePath -Destination $licenseDestination -Force
}

$noticeSource = Join-Path $PSScriptRoot 'OSMAND-RESOURCES-NOTICE.md'
if (-not (Test-Path -LiteralPath $noticeSource -PathType Leaf)) {
    throw "OsmAnd resources notice is missing: $noticeSource"
}
Copy-Item -LiteralPath $noticeSource -Destination (Join-Path $destinationPath 'NOTICE.md') -Force

$verification = @(
    'rendering_styles\default.render.xml',
    'rendering_styles\fonts\05_NotoSans-Regular.ttf',
    'rendering_styles\fonts\LICENSE.txt',
    'poi\poi_types.xml',
    'routing\routing.xml',
    'misc\icu4c\icudt52l.dat',
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

$styleCount = (Get-ChildItem -LiteralPath $styleDestination -File -Filter '*.render.xml').Count
$fontCount = (Get-ChildItem -LiteralPath $fontDestination -File -Filter '*.ttf').Count
$fileCount = (Get-ChildItem -LiteralPath $destinationPath -File -Recurse).Count
$totalBytes = (Get-ChildItem -LiteralPath $destinationPath -File -Recurse | Measure-Object -Property Length -Sum).Sum

Write-Host 'OsmAnd resources staged (license-cleared whitelist):'
Write-Host "  Source:      $source"
Write-Host "  Destination: $destinationPath"
Write-Host "  Styles:      $styleCount"
Write-Host "  Fonts:       $fontCount"
Write-Host "  Files:       $fileCount"
Write-Host "  Size:        $([math]::Round($totalBytes / 1MB, 2)) MiB"
Write-Host '  Graphics:    excluded pending per-asset license verification'
