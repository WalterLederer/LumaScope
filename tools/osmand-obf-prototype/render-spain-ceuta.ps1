[CmdletBinding()]
param(
    [string]$SdkRoot = (Join-Path $env:LOCALAPPDATA 'LumaScope\OsmAnd-SDK'),
    [string]$QtRoot = 'C:\Qt\6.12.0\mingw_64',
    [string]$MinGWRoot = 'C:\Qt\Tools\mingw1310_64',
    [string]$PythonExe = 'python',
    [string]$CMakeExe = 'cmake',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
git config --global core.longpaths true

$SdkRepository = 'https://github.com/OliverZhaohaibin/PySide6-OsmAnd-SDK.git'
$SdkCommit = 'b1a9d1a365bbfbca0572f35462b58b14ba6437db'

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Assert-Path {
    param([Parameter(Mandatory = $true)][string]$PathToCheck)
    if (-not (Test-Path -LiteralPath $PathToCheck)) {
        throw "Required path not found: $PathToCheck"
    }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$obfPath = Join-Path $repoRoot 'tools\Austria_wien_europe.obf'
Assert-Path $obfPath
Assert-Command 'git'
Assert-Command $PythonExe
Assert-Command $CMakeExe
Assert-Path (Join-Path $QtRoot 'bin\qmake.exe')
Assert-Path (Join-Path $MinGWRoot 'bin\g++.exe')
Assert-Path (Join-Path $MinGWRoot 'bin\mingw32-make.exe')

$pythonVersion = & $PythonExe -c 'import sys; print(sys.version_info.major, sys.version_info.minor)'
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to query the selected Python interpreter.'
}
$versionParts = $pythonVersion.Trim() -split '\s+'
if ($versionParts.Count -lt 2) {
    throw "Unable to parse Python version output: $pythonVersion"
}
if ([int]$versionParts[0] -lt 3 -or ([int]$versionParts[0] -eq 3 -and [int]$versionParts[1] -lt 12)) {
    throw "Python 3.12 or newer is required. Found $($versionParts[0]).$($versionParts[1])."
}

$cmakeCommand = Get-Command $CMakeExe
$cmakePath = $cmakeCommand.Source
if (-not $cmakePath) {
    $cmakePath = $cmakeCommand.Definition
}

$sdkParent = Split-Path -Parent $SdkRoot
New-Item -ItemType Directory -Force -Path $sdkParent | Out-Null

if (-not (Test-Path -LiteralPath $SdkRoot)) {
    Write-Host "Cloning isolated OsmAnd SDK to $SdkRoot"
    & git clone --filter=blob:none --no-checkout $SdkRepository $SdkRoot
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to clone the external OsmAnd SDK.'
    }
}
elseif (-not (Test-Path -LiteralPath (Join-Path $SdkRoot '.git'))) {
    throw "SDK path exists but is not a Git checkout: $SdkRoot"
}

$currentCommit = (& git -C $SdkRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $currentCommit -ne $SdkCommit) {
    $workingTree = & git -C $SdkRoot status --porcelain 2>$null
    if ($workingTree) {
        throw "The SDK checkout has local changes. Refusing to overwrite them: $SdkRoot"
    }
    & git -C $SdkRoot fetch --depth 1 origin $SdkCommit
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to fetch pinned SDK commit $SdkCommit."
    }
    & git -C $SdkRoot checkout --detach $SdkCommit
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to check out the pinned SDK revision.'
    }
}

$indexPath = (& git -C $SdkRoot rev-parse --git-path index).Trim()

if (-not [IO.Path]::IsPathRooted($indexPath)) {
    $indexPath = Join-Path $SdkRoot $indexPath
}

$checkoutIncomplete = (
    -not (Test-Path -LiteralPath $indexPath) -or
    -not (Test-Path -LiteralPath (Join-Path $SdkRoot 'pyproject.toml'))
)

if ($checkoutIncomplete) {
    Write-Host 'SDK checkout incomplete. Restoring pinned revision...'

    & git -C $SdkRoot reset --hard $SdkCommit

    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to restore the SDK checkout.'
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $SdkRoot 'pyproject.toml'))) {
    throw 'SDK checkout is still incomplete: pyproject.toml is missing.'
}

$venvPython = Join-Path $SdkRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Creating isolated Python environment'
    & $PythonExe -m venv (Join-Path $SdkRoot '.venv')
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to create the SDK Python environment.'
    }
}

Push-Location $SdkRoot
try {
    Write-Host 'Installing the SDK Python dependencies'
    & $venvPython -m pip install --disable-pip-version-check -e .
    if ($LASTEXITCODE -ne 0) {
        throw 'Installing the SDK Python dependencies failed.'
    }

    $helperBuildScript = Join-Path $SdkRoot 'tools\osmand_render_helper_native\build_helper.ps1'
    $helperExe = Join-Path $SdkRoot 'tools\osmand_render_helper_native\dist\osmand_render_helper.exe'

    if (-not $SkipBuild -or -not (Test-Path -LiteralPath $helperExe)) {
        Write-Host 'Building the OsmAnd rendering helper'
        & $helperBuildScript -QtRoot $QtRoot -MinGWRoot $MinGWRoot -CMakeExe $cmakePath -Generator 'MinGW Makefiles'
        if ($LASTEXITCODE -ne 0) {
            throw 'Building the OsmAnd rendering helper failed.'
        }
    }

    Assert-Path $helperExe
    $resourcesRoot = Join-Path $SdkRoot 'vendor\osmand\resources'
    $stylePath = Join-Path $resourcesRoot 'rendering_styles\default.render.xml'
    Assert-Path $resourcesRoot
    Assert-Path $stylePath

    $env:IPHOTO_OSMAND_OBF_PATH = $obfPath
    $env:IPHOTO_OSMAND_RESOURCES_ROOT = $resourcesRoot
    $env:IPHOTO_OSMAND_STYLE_PATH = $stylePath
    $env:IPHOTO_OSMAND_RENDER_HELPER = $helperExe
    $env:IPHOTO_OSMAND_QT_ROOT = $QtRoot
    $env:IPHOTO_OSMAND_MINGW_ROOT = $MinGWRoot

    $screenshotPath = Join-Path $env:TEMP 'LumaScope-OsmAnd-Spain-Ceuta.png'
    Remove-Item -LiteralPath $screenshotPath -Force -ErrorAction SilentlyContinue

    Write-Host "Rendering OBF: $obfPath"
    Write-Host "Style: $stylePath"
    Write-Host "Screenshot target: $screenshotPath"

    & $venvPython -m maps.main --backend python --center 16.3738 48.2082 --zoom 12 --screenshot $screenshotPath --capture-delay-ms 5000
    if ($LASTEXITCODE -ne 0) {
        throw "OsmAnd preview exited with code $LASTEXITCODE."
    }
    Assert-Path $screenshotPath
    Write-Host "OsmAnd OBF rendering succeeded: $screenshotPath"
}
finally {
    Pop-Location
}
