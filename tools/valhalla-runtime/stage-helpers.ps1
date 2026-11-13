#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$BuildDirectory = $env:LUMASCOPE_VALHALLA_BUILD,
    [string]$Destination = (Join-Path $PSScriptRoot 'stage\helpers')
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($BuildDirectory)) {
    $BuildDirectory = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'Valhalla\build-release'
}

if (-not (Test-Path -LiteralPath $BuildDirectory -PathType Container)) {
    throw "Valhalla build directory not found: $BuildDirectory. Set LUMASCOPE_VALHALLA_BUILD to the local Valhalla build-release directory."
}

$buildRoot = (Resolve-Path -LiteralPath $BuildDirectory).Path
$helper = Join-Path $buildRoot 'RelWithDebInfo\valhalla_route_helper.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Valhalla route helper not found: $helper. Build target valhalla_route_helper with configuration RelWithDebInfo first."
}

$runtimeDirectories = @(
    (Join-Path $buildRoot 'RelWithDebInfo'),
    (Join-Path $buildRoot 'Release'),
    (Join-Path $buildRoot 'src\Release'),
    (Join-Path $buildRoot 'vcpkg_installed\x64-windows-release\bin'),
    (Join-Path (Split-Path -Parent $buildRoot) 'vcpkg\installed\x64-windows-release\bin')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique

if ($runtimeDirectories.Count -lt 2) {
    throw "Valhalla runtime DLL directories were not found under '$buildRoot'. Expected the build Release and vcpkg runtime directories."
}

$destinationPath = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null

# Start with a clean staging directory so DLLs from an older Valhalla build
# cannot remain beside the newly staged helper.
Get-ChildItem -LiteralPath $destinationPath -Force | Remove-Item -Recurse -Force
Copy-Item -LiteralPath $helper -Destination (Join-Path $destinationPath 'valhalla_route_helper.exe') -Force

$copiedDlls = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($directory in $runtimeDirectories) {
    foreach ($dll in Get-ChildItem -LiteralPath $directory -Filter '*.dll' -File) {
        $target = Join-Path $destinationPath $dll.Name
        if ($copiedDlls.Add($dll.Name)) {
            Copy-Item -LiteralPath $dll.FullName -Destination $target -Force
        }
        elseif ((Get-Item -LiteralPath $target).Length -ne $dll.Length) {
            throw "Conflicting runtime DLL '$($dll.Name)' was found in '$directory'. Resolve the duplicate before packaging."
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $destinationPath 'valhalla_route_helper.exe') -PathType Leaf)) {
    throw 'Valhalla helper staging verification failed.'
}

Write-Host 'Valhalla helper runtime staged:'
Write-Host "  Build:       $buildRoot"
Write-Host "  Helper:      $((Get-Item (Join-Path $destinationPath 'valhalla_route_helper.exe')).Length) bytes"
Write-Host "  Destination: $destinationPath"
Write-Host "  DLL files:   $($copiedDlls.Count)"
