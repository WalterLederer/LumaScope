#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Source = (Join-Path $PSScriptRoot '..\osmand_render_helper_native\dist'),
    [string]$Destination = (Join-Path $PSScriptRoot 'stage\helpers')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "LumaScope OsmAnd helper distribution directory not found: $Source"
}
$source = (Resolve-Path -LiteralPath $Source).Path

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

# The Atlas worker passes the explicit display-density argument. Reject an
# outdated SDK binary here instead of silently packaging a helper that exits
# with code 2 on every render request.
$atlasHelper = Join-Path $source 'osmand_atlas_render_helper.exe'
$atlasUsage = (& $atlasHelper 2>&1 | Out-String)
$atlasExitCode = $LASTEXITCODE
if ($atlasExitCode -ne 2 -or $atlasUsage -notmatch '<display-scale>') {
    throw "The Atlas helper in '$source' is outdated. Rebuild osmand_atlas_render_helper from the current LumaScope tools source; it must accept <map.obf> <resources-root> <style-file> <display-scale>."
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
& robocopy.exe $source $destinationPath /MIR /COPY:DAT /DCOPY:DAT /R:1 /W:1 /MT:16 /XF $excludedFiles /NDL /NJH /NJS
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
