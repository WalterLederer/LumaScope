#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$BuildDirectory = (Join-Path $PSScriptRoot 'build'),
    [string]$Destination = (Join-Path $PSScriptRoot 'stage')
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'The Windows Shell context-menu helper must be built on Windows.' }

$source = $PSScriptRoot
$build = [IO.Path]::GetFullPath($BuildDirectory)
$destination = [IO.Path]::GetFullPath($Destination)

& cmake -S $source -B $build -A x64
if ($LASTEXITCODE -ne 0) { throw "Windows Shell context-menu CMake configuration failed ($LASTEXITCODE)." }

& cmake --build $build --config Release --parallel 8
if ($LASTEXITCODE -ne 0) { throw "Windows Shell context-menu helper build failed ($LASTEXITCODE)." }

$executable = Join-Path $destination 'lumascope_windows_shell_context_menu.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Windows Shell context-menu helper was not created: $executable"
}
Write-Host "Windows Shell context-menu helper ready: $executable"
