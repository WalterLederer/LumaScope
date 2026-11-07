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
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null

# Preserve the stage directory between builds. Robocopy transfers only changed
# files and removes stale files while keeping the destination usable if a later
# build is interrupted. Packaging is allowed only after a successful sync.
$excludedFiles = @(
    'atlas-frame-poc-debug.png',
    'osmand_atlas_frame_poc.exe',
    'osmand_native_widget.dll'
)
& robocopy.exe $source $destinationPath /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /XF $excludedFiles /NFL /NDL /NJH /NJS
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -ge 8) {
    throw "OsmAnd helper synchronization failed (robocopy exit code $robocopyExitCode)."
}

foreach ($name in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $destinationPath $name) -PathType Leaf)) {
        throw "Staging verification failed; file is missing: $name"
    }
}

Write-Host 'OsmAnd helper runtime synchronized incrementally:'
Write-Host "  Source:      $source"
Write-Host "  Destination: $destinationPath"
Write-Host "  Old helper:  $((Get-Item (Join-Path $destinationPath 'osmand_render_helper.exe')).Length) bytes"
Write-Host "  Atlas helper:$((Get-Item (Join-Path $destinationPath 'osmand_atlas_render_helper.exe')).Length) bytes"
Write-Host "  Files:       $((Get-ChildItem -LiteralPath $destinationPath -File -Recurse).Count)"
