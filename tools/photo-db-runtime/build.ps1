#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$VcpkgRoot = $env:VCPKG_ROOT,
    [string]$BuildDirectory = (Join-Path $PSScriptRoot 'build'),
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($VcpkgRoot)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $candidate = Join-Path (Split-Path -Parent $repoRoot) 'Valhalla\vcpkg'
    if (Test-Path -LiteralPath (Join-Path $candidate 'scripts\buildsystems\vcpkg.cmake')) {
        $VcpkgRoot = $candidate
    }
}

if ([string]::IsNullOrWhiteSpace($VcpkgRoot) -or
    -not (Test-Path -LiteralPath (Join-Path $VcpkgRoot 'scripts\buildsystems\vcpkg.cmake'))) {
    throw 'vcpkg was not found. Set VCPKG_ROOT or pass -VcpkgRoot.'
}

$VcpkgRoot = (Resolve-Path -LiteralPath $VcpkgRoot).Path
$toolchain = Join-Path $VcpkgRoot 'scripts\buildsystems\vcpkg.cmake'
$vcpkgExe = Join-Path $VcpkgRoot 'vcpkg.exe'
if (-not (Test-Path -LiteralPath $vcpkgExe -PathType Leaf)) {
    throw "vcpkg executable was not found: $vcpkgExe"
}

$BuildDirectory = [System.IO.Path]::GetFullPath($BuildDirectory)
$installedDirectory = Join-Path $BuildDirectory 'vcpkg_installed'
$triplet = 'x64-windows-release'

# Install the manifest dependencies explicitly so missing packages are reported
# here rather than later as an opaque CMake find_package failure.
Write-Host "Installing photo DB helper dependencies ($triplet)..." -ForegroundColor Cyan
& $vcpkgExe install "--triplet=$triplet" "--x-manifest-root=$PSScriptRoot" "--x-install-root=$installedDirectory"
if ($LASTEXITCODE -ne 0) { throw "vcpkg dependency installation failed (exit code $LASTEXITCODE)." }

& cmake -S $PSScriptRoot -B $BuildDirectory "-DCMAKE_TOOLCHAIN_FILE=$toolchain" "-DVCPKG_MANIFEST_DIR=$PSScriptRoot" "-DVCPKG_INSTALLED_DIR=$installedDirectory" "-DVCPKG_TARGET_TRIPLET=$triplet" '-DVCPKG_APPLOCAL_DEPS=ON'
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed (exit code $LASTEXITCODE)." }

& cmake --build $BuildDirectory --config $Configuration --parallel 8
if ($LASTEXITCODE -ne 0) { throw "Photo DB helper build failed (exit code $LASTEXITCODE)." }

$exe = Join-Path $BuildDirectory "$Configuration\photo_db_update_helper.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { $exe = Join-Path $BuildDirectory 'photo_db_update_helper.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build completed but photo_db_update_helper.exe was not found.' }

Write-Host "Photo DB helper built: $exe" -ForegroundColor Green
