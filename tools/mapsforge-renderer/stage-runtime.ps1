#requires -Version 7.0

[CmdletBinding()]
param(
    [string]$JavaHome = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
$jarPath = Join-Path $PSScriptRoot 'target\mapsforge-renderer.jar'
$stageRoot = Join-Path $PSScriptRoot 'stage'
$runtimePath = Join-Path $stageRoot 'runtime'
$tempRuntimePath = Join-Path $stageRoot 'runtime.tmp'
$markerName = '.lumascope-runtime.json'

if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
    throw "Mapsforge renderer JAR not found: $jarPath. Run 'npm run build:mapsforge-renderer' first."
}

# jlink needs the packaged JDK modules (jmods). Some IDE/tool installations
# expose javac.exe but ship a trimmed JDK without these modules. Prefer JAVA_HOME
# when it is complete, otherwise locate another full JDK on PATH or in common
# Windows installation directories.
$javaHomeCandidates = [System.Collections.Generic.List[string]]::new()
if (-not [string]::IsNullOrWhiteSpace($JavaHome)) {
    $javaHomeCandidates.Add($JavaHome)
}

foreach ($commandName in @('javac.exe', 'java.exe')) {
    $javaCommand = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($javaCommand -and $javaCommand.Source) {
        $binDirectory = Split-Path $javaCommand.Source -Parent
        $javaHomeCandidates.Add((Split-Path $binDirectory -Parent))
    }
}

$jdkRoots = @(
    (Join-Path $env:ProgramFiles 'Java'),
    (Join-Path $env:ProgramFiles 'Eclipse Adoptium'),
    (Join-Path $env:ProgramFiles 'Microsoft'),
    (Join-Path $env:ProgramFiles 'Amazon Corretto'),
    (Join-Path $env:ProgramFiles 'BellSoft'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Eclipse Adoptium'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

foreach ($root in $jdkRoots) {
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $javaHomeCandidates.Add($_.FullName) }
}

$validJavaHomes = @()
foreach ($candidate in ($javaHomeCandidates | Where-Object { $_ } | Select-Object -Unique)) {
    $candidateJavac = Join-Path $candidate 'bin\javac.exe'
    $candidateTools = @(
        (Join-Path $candidate 'bin\jlink.exe'),
        (Join-Path $candidate 'bin\jdeps.exe'),
        $candidateJavac,
        (Join-Path $candidate 'jmods\java.base.jmod')
    )
    if (@($candidateTools | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
        continue
    }

    $candidateVersion = (& $candidateJavac -version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $candidateVersion -match 'javac\s+(\d+)') {
        $candidateMajor = [int]$Matches[1]
        if ($candidateMajor -ge 17) {
            $validJavaHomes += $candidate
        }
        else {
            Write-Host "Skipping unsupported JDK: $candidateVersion ($candidate)" -ForegroundColor DarkGray
        }
    }
}

if ($validJavaHomes.Count -eq 0) {
    $configuredHome = if ([string]::IsNullOrWhiteSpace($JavaHome)) { '<not set>' } else { $JavaHome }
    throw "A full JDK 17 or newer with jlink.exe, jdeps.exe, javac.exe and jmods\java.base.jmod is required to create the bundled Mapsforge runtime. No suitable JDK was found. JAVA_HOME currently points to '$configuredHome'. Install a full JDK (for example Temurin 25) and set JAVA_HOME to its installation directory."
}

$preferredJavaHome = $validJavaHomes[0]
if (-not [string]::IsNullOrWhiteSpace($JavaHome) -and $validJavaHomes -contains $JavaHome) {
    $preferredJavaHome = $JavaHome
}
$JavaHome = (Resolve-Path -LiteralPath $preferredJavaHome).Path
Write-Host "Using full JDK for Mapsforge runtime: $JavaHome" -ForegroundColor DarkGray

$JavaHome = (Resolve-Path -LiteralPath $JavaHome).Path
$jdkBin = Join-Path $JavaHome 'bin'
$jlink = Join-Path $jdkBin 'jlink.exe'
$jdeps = Join-Path $jdkBin 'jdeps.exe'
$javac = Join-Path $jdkBin 'javac.exe'

foreach ($tool in @($jlink, $jdeps, $javac)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "Required JDK tool not found: $tool. JAVA_HOME must point to a full JDK, not a JRE."
    }
}

$javacOutput = (& $javac -version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $javacOutput -notmatch 'javac\s+(\d+)') {
    throw "Could not determine the JDK version from: $javacOutput"
}
$jdkMajor = [int]$Matches[1]
if ($jdkMajor -lt 17) {
    throw "Mapsforge requires JDK 17 or newer to build its runtime. Found: $javacOutput"
}

$jarHash = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash
$markerPath = Join-Path $runtimePath $markerName
if ((Test-Path -LiteralPath (Join-Path $runtimePath 'bin\java.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        if ($marker.JarSha256 -eq $jarHash -and
            $marker.JdkHome -eq $JavaHome -and
            $marker.JdkMajor -eq $jdkMajor) {
            Write-Host "Mapsforge Java runtime is up to date (JDK $jdkMajor)." -ForegroundColor Green
            return
        }
    }
    catch {
        Write-Host 'Existing Mapsforge runtime marker is invalid; rebuilding the runtime.' -ForegroundColor Yellow
    }
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
if (Test-Path -LiteralPath $tempRuntimePath) {
    Remove-Item -LiteralPath $tempRuntimePath -Recurse -Force
}

Write-Host "Analyzing Mapsforge Java module dependencies (JDK $jdkMajor)..." -ForegroundColor Cyan
$moduleOutput = & $jdeps --multi-release 17 --print-module-deps --ignore-missing-deps $jarPath 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "jdeps failed: $($moduleOutput -join [Environment]::NewLine)"
}
$modules = (($moduleOutput | Select-Object -Last 1).ToString().Trim() -split ',') |
    Where-Object { $_ } |
    Select-Object -Unique
if ($modules -notcontains 'java.desktop') {
    $modules += 'java.desktop'
}
$moduleList = ($modules | Sort-Object) -join ','
Write-Host "Required Java modules: $moduleList" -ForegroundColor DarkGray

Write-Host 'Creating minimized Mapsforge Java runtime...' -ForegroundColor Cyan
$jlinkArgs = @(
    '--module-path', (Join-Path $JavaHome 'jmods'),
    '--add-modules', $moduleList,
    '--bind-services',
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=2',
    '--output', $tempRuntimePath
)
& $jlink @jlinkArgs
if ($LASTEXITCODE -ne 0) {
    throw "jlink failed with exit code $LASTEXITCODE."
}

$runtimeJava = Join-Path $tempRuntimePath 'bin\java.exe'
if (-not (Test-Path -LiteralPath $runtimeJava -PathType Leaf)) {
    throw "jlink did not create the expected runtime executable: $runtimeJava"
}
$runtimeVersion = (& $runtimeJava -version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "The staged Java runtime failed its startup check: $runtimeVersion"
}

$marker = [ordered]@{
    JdkHome = $JavaHome
    JdkMajor = $jdkMajor
    JarSha256 = $jarHash
    RuntimeVersion = $runtimeVersion
    GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
}
$marker | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $tempRuntimePath $markerName) -Encoding utf8

if (Test-Path -LiteralPath $runtimePath) {
    Remove-Item -LiteralPath $runtimePath -Recurse -Force
}
Move-Item -LiteralPath $tempRuntimePath -Destination $runtimePath

$runtimeSize = (Get-ChildItem -LiteralPath $runtimePath -File -Recurse | Measure-Object -Property Length -Sum).Sum
Write-Host ("Mapsforge Java runtime staged successfully: {0:N0} MB (JDK {1})." -f ($runtimeSize / 1MB), $jdkMajor) -ForegroundColor Green
