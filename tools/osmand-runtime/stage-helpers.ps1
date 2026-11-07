#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$SdkRoot = $(if ($env:LUMASCOPE_OSMAND_SDK_ROOT) {
        $env:LUMASCOPE_OSMAND_SDK_ROOT
    } else {
        Join-Path $PSScriptRoot '..\..\..\OsmAnd-SDK'
    }),
    [string]$Destination = (Join-Path $PSScriptRoot 'stage\helpers')
)

$ErrorActionPreference = 'Stop'

$sdkRootResolved = (Resolve-Path -LiteralPath $SdkRoot).Path
$source = Join-Path $sdkRootResolved 'tools\osmand_render_helper_native\dist'
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "OsmAnd helper distribution directory not found: $source"
}

$requiredFiles = @(
    'osmand_render_helper.exe',
    'osmand_atlas_render_helper.exe',
    'Qt6Core.dll',
    'Qt6Gui.dll',
    'Qt6Widgets.dll',
    'Qt6OpenGL.dll',
    'Qt6OpenGLWidgets.dll',
    'libgcc_s_seh-1.dll',
    'libstdc++-6.dll',
    'libwinpthread-1.dll'
)
foreach ($name in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
        throw "Required OsmAnd runtime file is missing: $(Join-Path $source $name)"
    }
}

$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force
}
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null

# Stage the shared Qt/MinGW deployment and both persistent renderers.
# Exclude only the one-shot POC artifacts and the separately built native widget DLL.
$excludedFiles = @(
    'atlas-frame-poc-debug.png',
    'osmand_atlas_frame_poc.exe',
    'osmand_native_widget.dll'
)
Get-ChildItem -LiteralPath $source -Force | Where-Object {
    $_.Name -notin $excludedFiles
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $destinationPath -Recurse -Force
}

foreach ($name in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $destinationPath $name) -PathType Leaf)) {
        throw "Staging verification failed; file was not copied: $name"
    }
}

Write-Host "OsmAnd helper runtime staged:"
Write-Host "  Source:      $source"
Write-Host "  Destination: $destinationPath"
Write-Host "  Old helper:  $((Get-Item (Join-Path $destinationPath 'osmand_render_helper.exe')).Length) bytes"
Write-Host "  Atlas helper:$((Get-Item (Join-Path $destinationPath 'osmand_atlas_render_helper.exe')).Length) bytes"
Write-Host "  Files:       $((Get-ChildItem -LiteralPath $destinationPath -File -Recurse).Count)"
