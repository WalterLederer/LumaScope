param(
    [string]$OsmAndWorkspaceRoot = "",
    [string]$QtRoot = "C:\Qt\6.12.0\mingw_64",
    [string]$MinGWRoot = "C:\Qt\Tools\mingw1310_64",
    [string]$CMakeExe = "C:\Qt\Tools\CMake_64\bin\cmake.exe",
    [string]$GitBashExe = "C:\Program Files\Git\bin\bash.exe",
    [string]$WorkspaceDrive = "O:",
    [ValidateSet("Debug", "Release", "RelWithDebInfo", "MinSizeRel")]
    [string]$BuildType = "Release",
    [ValidateRange(1, 64)]
    [int]$Jobs = 8,
    [switch]$SkipLegacyProtobuf,
    [switch]$ConfigureOnly,
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"

if ($ConfigureOnly -and $BuildOnly) {
    throw "ConfigureOnly and BuildOnly can not be used together."
}

function Ensure-Junction {
    param(
        [Parameter(Mandatory = $true)][string]$LinkPath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Path already exists and is not a junction: $LinkPath"
        }
        return
    }

    New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
}

function Ensure-SubstDrive {
    param(
        [Parameter(Mandatory = $true)][string]$DriveName,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    $normalizedDrive = $DriveName.TrimEnd(":").ToUpperInvariant() + ":"
    $escapedDrive = [regex]::Escape($normalizedDrive)
    $currentMappings = & cmd /c subst
    foreach ($line in $currentMappings) {
        if ($line -match "^${escapedDrive}\\: => (.+)$") {
            if ($Matches[1] -ieq $TargetPath) {
                return
            }
            throw "$normalizedDrive is already mapped to $($Matches[1])"
        }
    }

    & cmd /c "subst $normalizedDrive `"$TargetPath`""
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create $normalizedDrive for $TargetPath"
    }
}

function Get-SubstDriveMappings {
    $mappings = @{}
    $currentMappings = & cmd /c subst
    foreach ($line in $currentMappings) {
        if ($line -match '^([A-Z]:)\\: => (.+)$') {
            $mappings[$Matches[1].ToUpperInvariant()] = $Matches[2]
        }
    }
    return $mappings
}

function Resolve-WorkspaceDrive {
    param(
        [Parameter(Mandatory = $true)][string]$PreferredDrive,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )

    $normalizedPreferred = $PreferredDrive.TrimEnd(':').ToUpperInvariant() + ':'
    $mappings = Get-SubstDriveMappings
    if ($mappings.ContainsKey($normalizedPreferred)) {
        if ($mappings[$normalizedPreferred] -ieq $TargetPath) {
            return $normalizedPreferred
        }
    }
    elseif (-not (Test-Path "${normalizedPreferred}\")) {
        return $normalizedPreferred
    }

    foreach ($letter in @('P','Q','R','S','T','U','V','W','X','Y','Z','N','M','L','K','J','I','H','G','F','E')) {
        $candidate = "${letter}:"
        if ($candidate -ieq $normalizedPreferred) {
            continue
        }
        if ($mappings.ContainsKey($candidate)) {
            if ($mappings[$candidate] -ieq $TargetPath) {
                return $candidate
            }
            continue
        }
        if (-not (Test-Path "${candidate}\")) {
            return $candidate
        }
    }

    throw "Unable to find an available SUBST drive for $TargetPath"
}

function Assert-Exists {
    param([Parameter(Mandatory = $true)][string]$PathToCheck)
    if (-not (Test-Path $PathToCheck)) {
        throw "Required path does not exist: $PathToCheck"
    }
}

function Copy-IfPresent {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationDir
    )

    if (-not (Test-Path $SourcePath)) {
        return
    }

    Copy-Item -Path $SourcePath -Destination $DestinationDir -Force
}

function To-CMakePath {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ($Value -replace '\\', '/')
}

function To-BashPath {
    param([Parameter(Mandatory = $true)][string]$Value)

    $fullPath = [IO.Path]::GetFullPath($Value)
    $drive = $fullPath.Substring(0, 1).ToLowerInvariant()
    $rest = $fullPath.Substring(2) -replace '\\', '/'
    return "/$drive$rest"
}

function Repair-SkiaMinGWDirectWriteCompatibility {
    param(
        [Parameter(Mandatory = $true)][string]$DWriteHeaderPath,
        [Parameter(Mandatory = $true)][string]$ScalerContextSourcePath
    )

    Assert-Exists $DWriteHeaderPath
    Assert-Exists $ScalerContextSourcePath

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $headerContent = [System.IO.File]::ReadAllText($DWriteHeaderPath)
    $scalerContent = [System.IO.File]::ReadAllText($ScalerContextSourcePath)

    if ($headerContent -match 'GetGlyphImageFormats_\(') {
        $repairedScalerContent = $scalerContent -replace '(?<!_)GetGlyphImageFormats\(', 'GetGlyphImageFormats_('
    }
    else {
        $repairedScalerContent = $scalerContent.Replace('GetGlyphImageFormats_(', 'GetGlyphImageFormats(')
    }

    if ($repairedScalerContent -ne $scalerContent) {
        [System.IO.File]::WriteAllText($ScalerContextSourcePath, $repairedScalerContent, $utf8NoBom)
    }
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "..\.."))
if (-not $OsmAndWorkspaceRoot) {
    $OsmAndWorkspaceRoot = Join-Path $repoRoot "build\official-workspace"
}

$vendorRoot = Join-Path $repoRoot "vendor\osmand"
$officialBuildRoot = Join-Path $vendorRoot "build"
$officialCppToolsRoot = Join-Path $projectRoot "official_cpp_tools"
$qt5CoreShim = Join-Path $projectRoot "cmake\Qt5Core"
$qt5NetworkShim = Join-Path $projectRoot "cmake\Qt5Network"
$toolchainFile = Join-Path $projectRoot "toolchains\amd64-windows-gcc.cmake"
$mingwDWriteHeader = Join-Path $MinGWRoot "x86_64-w64-mingw32\include\dwrite_3.h"

$workspaceRoot = [IO.Path]::GetFullPath($OsmAndWorkspaceRoot)
$WorkspaceDrive = Resolve-WorkspaceDrive -PreferredDrive $WorkspaceDrive -TargetPath $workspaceRoot
$workspaceDriveLetter = $WorkspaceDrive.TrimEnd(':').ToLowerInvariant()
$workspaceDriveRoot = "$($WorkspaceDrive.TrimEnd(':')):\"
$shortBuildRoot = "${workspaceDriveRoot}build"
$shortBuildDir = "${workspaceDriveRoot}baked\amd64-windows-gcc.qt6"
$physicalBuildDir = Join-Path $workspaceRoot "baked\amd64-windows-gcc.qt6"
$helperOutputDir = Join-Path $workspaceRoot "binaries\windows\gcc-amd64\$BuildType"
$helperOutputPath = Join-Path $helperOutputDir "osmand_render_helper.exe"
$searchHelperOutputPath = Join-Path $helperOutputDir "osmand_search_helper.exe"
$nativeWidgetOutputPath = Join-Path $helperOutputDir "osmand_native_widget.dll"
$localDistDir = Join-Path $projectRoot "dist"

Assert-Exists $repoRoot
Assert-Exists $vendorRoot
Assert-Exists $officialBuildRoot
Assert-Exists (Join-Path $vendorRoot "core")
Assert-Exists (Join-Path $vendorRoot "core-legacy")
Assert-Exists (Join-Path $vendorRoot "resources")

$resourcesRoot = Join-Path $vendorRoot "resources"
$resourcesCMakeLists = Join-Path $resourcesRoot "CMakeLists.txt"
$resourcesBundleCMake = Join-Path $resourcesRoot "resources-bundle.cmake"
Assert-Exists $resourcesCMakeLists

if (-not (Test-Path -LiteralPath $resourcesBundleCMake -PathType Leaf)) {
    Write-Warning "OsmAnd resources checkout is missing resources-bundle.cmake. Attempting to restore the tracked file from its current Git revision."
    $isGitRepository = & git -C $resourcesRoot rev-parse --is-inside-work-tree 2>$null
    if ($LASTEXITCODE -eq 0 -and $isGitRepository -eq "true") {
        & git -C $resourcesRoot restore --source=HEAD -- resources-bundle.cmake
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not restore resources-bundle.cmake from the current checkout."
        }
    }

    if (-not (Test-Path -LiteralPath $resourcesBundleCMake -PathType Leaf)) {
        throw "The OsmAnd resources checkout is incomplete: '$resourcesBundleCMake' is missing. The upstream OsmAnd-resources repository contains this file beside CMakeLists.txt. Update or re-clone vendor\osmand\resources, then rerun this script. CMake configuration was stopped before it could fail later."
    }
}
Assert-Exists $projectRoot
Assert-Exists $officialCppToolsRoot
Assert-Exists $qt5CoreShim
Assert-Exists $qt5NetworkShim
Assert-Exists $toolchainFile
Assert-Exists $QtRoot
Assert-Exists $MinGWRoot
Assert-Exists $CMakeExe
Assert-Exists $GitBashExe

New-Item -ItemType Directory -Force -Path $workspaceRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $workspaceRoot "tools") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $workspaceRoot "baked") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $workspaceRoot "binaries") | Out-Null

Ensure-Junction -LinkPath (Join-Path $workspaceRoot "build") -TargetPath $officialBuildRoot
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "OsmAnd-core") -TargetPath (Join-Path $vendorRoot "core")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "OsmAnd-core-legacy") -TargetPath (Join-Path $vendorRoot "core-legacy")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "OsmAnd-resources") -TargetPath (Join-Path $vendorRoot "resources")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "core") -TargetPath (Join-Path $workspaceRoot "OsmAnd-core")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "core-legacy") -TargetPath (Join-Path $workspaceRoot "OsmAnd-core-legacy")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "resources") -TargetPath (Join-Path $workspaceRoot "OsmAnd-resources")
Ensure-Junction -LinkPath (Join-Path $workspaceRoot "tools\cpp-tools") -TargetPath $officialCppToolsRoot

Repair-SkiaMinGWDirectWriteCompatibility `
    -DWriteHeaderPath $mingwDWriteHeader `
    -ScalerContextSourcePath (Join-Path $workspaceRoot "OsmAnd-core\externals\skia\upstream.patched\src\ports\SkScalerContext_win_dw.cpp")

$boostBuildBat = Join-Path $workspaceRoot "core\externals\boost\build.bat"
if (-not (Test-Path $boostBuildBat)) {
    @"
@echo off
bash --login "%~dp0build.sh" %*
"@ | Set-Content -Path $boostBuildBat -Encoding ASCII
}

& git config --global core.longpaths true

Ensure-SubstDrive -DriveName $WorkspaceDrive -TargetPath $workspaceRoot

# Python is only needed to prepare the legacy protobuf sources. Ignore the
# Microsoft Store execution aliases in WindowsApps: they are not Python installs.
$pythonExe = $null
$pythonBin = $null
if (-not $SkipLegacyProtobuf) {
    $pythonCandidates = @()
    foreach ($commandName in @("python3.exe", "python.exe")) {
        $commands = @(Get-Command $commandName -All -ErrorAction SilentlyContinue)
        foreach ($command in $commands) {
            if ($command.Source -and
                $command.Source -notmatch "[\\/]Microsoft[\\/]WindowsApps[\\/]" -and
                (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
                $pythonCandidates += $command.Source
            }
        }
    }

    foreach ($candidate in ($pythonCandidates | Select-Object -Unique)) {
        $versionOutput = & $candidate --version 2>&1
        if ($LASTEXITCODE -eq 0 -and ($versionOutput -match 'Python 3\.')) {
            $pythonExe = $candidate
            $pythonVersion = ($versionOutput | Out-String).Trim()
            break
        }
    }

    # Also support installations that expose only the Python Launcher (py.exe).
    if (-not $pythonExe) {
        $pyCommand = Get-Command "py.exe" -ErrorAction SilentlyContinue
        if ($pyCommand -and $pyCommand.Source -and
            $pyCommand.Source -notmatch "[\\/]Microsoft[\\/]WindowsApps[\\/]") {
            $resolvedPython = & $pyCommand.Source -3 -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $resolvedPython) {
                $candidate = ($resolvedPython | Select-Object -Last 1).Trim()
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $versionOutput = & $candidate --version 2>&1
                    if ($LASTEXITCODE -eq 0 -and ($versionOutput -match 'Python 3\.')) {
                        $pythonExe = $candidate
                        $pythonVersion = ($versionOutput | Out-String).Trim()
                    }
                }
            }
        }
    }

    if (-not $pythonExe) {
        throw "A working Python 3 installation is required for legacy protobuf preparation. The Microsoft Store WindowsApps alias is not a Python installation. Install Python 3 and add it to PATH, or rerun with -SkipLegacyProtobuf if legacy protobuf preparation is not required."
    }

    $pythonBin = Split-Path -Parent $pythonExe
    Write-Host "Using Python: $pythonExe ($pythonVersion)"
}

$pathEntries = @()
if ($pythonBin) {
    $pathEntries += $pythonBin
}
$pathEntries += @(
    (Join-Path $MinGWRoot "bin"),
    "C:\Program Files\Git\bin",
    "C:\Program Files\Git\usr\bin",
    "C:\Program Files\Git\mingw64\bin",
    $env:PATH
)
$env:PATH = ($pathEntries | Where-Object { $_ } | Select-Object -Unique) -join ";"

if (-not $SkipLegacyProtobuf) {
    $legacyProtobufScript = Join-Path $workspaceRoot "core-legacy\externals\protobuf\configure.sh"
    $pythonBinBash = To-BashPath $pythonBin
    $mingwBinBash = To-BashPath (Join-Path $MinGWRoot "bin")

    Assert-Exists $legacyProtobufScript
    & $GitBashExe -lc "export PATH=${pythonBinBash}:${mingwBinBash}:`$PATH; cd /${workspaceDriveLetter}/core-legacy/externals/protobuf && ./configure.sh"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to prepare legacy protobuf."
    }
}

$env:OSMAND_SYSTEM_QT = "1"

$projectRootCMake = To-CMakePath $projectRoot
$qtRootCMake = To-CMakePath $QtRoot
$mingwRootCMake = To-CMakePath $MinGWRoot
$toolchainFileCMake = To-CMakePath $toolchainFile
$qt5CoreShimCMake = To-CMakePath $qt5CoreShim
$qt5NetworkShimCMake = To-CMakePath $qt5NetworkShim

if (-not $BuildOnly) {
    if (Test-Path $physicalBuildDir) {
        Remove-Item -Recurse -Force $physicalBuildDir
    }

    & $CMakeExe `
        -S $shortBuildRoot `
        -B $shortBuildDir `
        -G "MinGW Makefiles" `
        "-DCMAKE_BUILD_TYPE=$BuildType" `
        "-DCMAKE_MAKE_PROGRAM=$mingwRootCMake/bin/mingw32-make.exe" `
        "-DCMAKE_PREFIX_PATH=$qtRootCMake" `
        "-DCMAKE_TOOLCHAIN_FILE=$toolchainFileCMake" `
        "-DOSMAND_MINGW_ROOT=$mingwRootCMake" `
        "-DOSMAND_RENDER_HELPER_SOURCE_ROOT=$projectRootCMake" `
        "-DQt5Core_DIR=$qt5CoreShimCMake" `
        "-DQt5Network_DIR=$qt5NetworkShimCMake" `
        "-Dws2_32_LIBRARY=ws2_32" `
        "-Dgdi32_LIBRARY=gdi32" `
        "-Ddwrite_LIBRARY=dwrite"
    if ($LASTEXITCODE -ne 0) {
        throw "Official OsmAnd CMake configure failed with exit code $LASTEXITCODE"
    }
}
elseif (-not (Test-Path $physicalBuildDir)) {
    throw "Build directory does not exist yet: $physicalBuildDir"
}

if (-not $ConfigureOnly) {
    & $CMakeExe --build $shortBuildDir --target osmand_render_helper osmand_search_helper osmand_native_widget --config $BuildType --parallel $Jobs
    if ($LASTEXITCODE -ne 0) {
        throw "Official OsmAnd helper build failed with exit code $LASTEXITCODE"
    }

    Assert-Exists $helperOutputPath
    Assert-Exists $searchHelperOutputPath
    Copy-IfPresent -SourcePath (Join-Path $QtRoot "bin\Qt6Core.dll") -DestinationDir $helperOutputDir
    Copy-IfPresent -SourcePath (Join-Path $QtRoot "bin\Qt6Network.dll") -DestinationDir $helperOutputDir
    Copy-IfPresent -SourcePath (Join-Path $MinGWRoot "bin\libgcc_s_seh-1.dll") -DestinationDir $helperOutputDir
    Copy-IfPresent -SourcePath (Join-Path $MinGWRoot "bin\libstdc++-6.dll") -DestinationDir $helperOutputDir
    Copy-IfPresent -SourcePath (Join-Path $MinGWRoot "bin\libwinpthread-1.dll") -DestinationDir $helperOutputDir

    New-Item -ItemType Directory -Force -Path $localDistDir | Out-Null
    Copy-Item -Path $helperOutputPath -Destination $localDistDir -Force
    Copy-Item -Path $searchHelperOutputPath -Destination $localDistDir -Force
    if (Test-Path $nativeWidgetOutputPath) {
        Copy-Item -Path $nativeWidgetOutputPath -Destination $localDistDir -Force
    }
    Get-ChildItem -Path $helperOutputDir -File -Filter *.dll | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $localDistDir -Force
    }
}

Write-Host "Official helper built at: $helperOutputPath"
if (-not $ConfigureOnly) {
    Write-Host "Helper runtime mirrored to: $localDistDir"
}
