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

if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    $javaCommand = Get-Command 'java.exe' -ErrorAction SilentlyContinue
    if ($javaCommand) {
        $JavaHome = Split-Path (Split-Path $javaCommand.Source -Parent) -Parent
    }
}

if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    throw 'A JDK 17 or newer is required to stage the bundled Mapsforge runtime. Set JAVA_HOME to a JDK installation.'
}

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
