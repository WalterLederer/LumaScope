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

# Identify the source tree recorded in this CMake build directory. This makes
# it visible in the build log which checkout is actually used for compilation.
$cmakeCache = Join-Path $buildRoot 'CMakeCache.txt'
if (Test-Path -LiteralPath $cmakeCache -PathType Leaf) {
    $sourceEntry = Select-String -LiteralPath $cmakeCache -Pattern '^CMAKE_HOME_DIRECTORY:INTERNAL=' | Select-Object -First 1
    if ($sourceEntry) {
        Write-Host "Valhalla source: $($sourceEntry.Line.Substring('CMAKE_HOME_DIRECTORY:INTERNAL='.Length))" -ForegroundColor Cyan
    }
}

# Register the helper source tracked in LumaScope with the existing Valhalla
# CMake build. The project include hook adds/replaces the target after Valhalla
# has defined its library targets, without editing the external Valhalla checkout.
$sourceDirectory = Split-Path -Parent $buildRoot
$valhallaSource = $null
if (Test-Path -LiteralPath $cmakeCache -PathType Leaf) {
    $sourceEntry = Select-String -LiteralPath $cmakeCache -Pattern '^CMAKE_HOME_DIRECTORY:INTERNAL=' | Select-Object -First 1
    if ($sourceEntry) {
        $valhallaSource = $sourceEntry.Line.Substring('CMAKE_HOME_DIRECTORY:INTERNAL='.Length)
    }
}
if ([string]::IsNullOrWhiteSpace($valhallaSource) -or -not (Test-Path -LiteralPath $valhallaSource -PathType Container)) {
    throw "Could not determine Valhalla source directory from '$cmakeCache'."
}

$helperSource = Join-Path $PSScriptRoot 'src\lumascope_route_helper.cpp'
$cmakeHook = Join-Path $PSScriptRoot 'cmake\LumaScopeValhallaHelper.cmake'
if (-not (Test-Path -LiteralPath $helperSource -PathType Leaf)) {
    throw "LumaScope Valhalla helper source not found: $helperSource"
}
if (-not (Test-Path -LiteralPath $cmakeHook -PathType Leaf)) {
    throw "LumaScope Valhalla CMake hook not found: $cmakeHook"
}

& cmake -S $valhallaSource -B $buildRoot "-DCMAKE_PROJECT_valhalla_INCLUDE=$cmakeHook" "-DLUMASCOPE_VALHALLA_HELPER_SOURCE=$helperSource"
if ($LASTEXITCODE -ne 0) {
    throw "Valhalla CMake configuration failed (exit code $LASTEXITCODE)."
}

# Let CMake decide whether compilation/linking is necessary. Do not delete the
# existing executable: an up-to-date target must remain untouched.
$helper = Join-Path $buildRoot 'RelWithDebInfo\valhalla_route_helper.exe'
$previousHelper = if (Test-Path -LiteralPath $helper -PathType Leaf) { Get-Item -LiteralPath $helper } else { $null }

& cmake --build $buildRoot --config RelWithDebInfo --target valhalla_route_helper --parallel 8
$buildExitCode = $LASTEXITCODE
if ($buildExitCode -ne 0) {
    throw "Valhalla helper build failed (cmake exit code $buildExitCode)."
}

if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Valhalla route helper build completed but the executable is missing: $helper"
}

$builtHelper = Get-Item -LiteralPath $helper
if ($null -eq $previousHelper -or $builtHelper.LastWriteTimeUtc -gt $previousHelper.LastWriteTimeUtc) {
    Write-Host "Valhalla helper was rebuilt: $($builtHelper.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss.fff'))" -ForegroundColor Green
}
else {
    Write-Host "Valhalla helper is up to date; no rebuild was needed." -ForegroundColor DarkGray
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
        else {
            # The first matching DLL wins. The build-local vcpkg directory is
            # listed before the sibling vcpkg fallback, so its ABI-compatible
            # runtime takes precedence over any older duplicate.
            $existingLength = (Get-Item -LiteralPath $target).Length
            if ($existingLength -ne $dll.Length) {
                Write-Warning "Ignoring duplicate runtime DLL '$($dll.Name)' from '$directory' ($($dll.Length) bytes); keeping the first copy ($existingLength bytes)."
            }
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
