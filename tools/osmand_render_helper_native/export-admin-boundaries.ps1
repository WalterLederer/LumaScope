#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$ObfPath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourcesRoot,

    [string]$OutputPath = (Join-Path (Get-Location) 'Stockerau_admin_boundary_candidates.gpx'),

    [string]$HelperPath = (Join-Path $PSScriptRoot '../../build/official-workspace/binaries/windows/gcc-amd64/Release/osmand_search_helper.exe'),

    [ValidateRange(0.1, 100.0)]
    [double]$RadiusKm = 20.0,

    [double]$Latitude = 48.38513,
    [double]$Longitude = 16.21005
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) {
    throw "OsmAnd search helper not found: $HelperPath. Build osmand_search_helper first."
}
foreach ($path in $ObfPath) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "OBF file not found: $path"
    }
    if ([IO.Path]::GetExtension($path) -ine '.obf') {
        throw "Not an OBF file: $path"
    }
}
if (-not (Test-Path -LiteralPath $ResourcesRoot -PathType Container)) {
    throw "OsmAnd resources folder not found: $ResourcesRoot"
}

function ConvertTo-Utf8HexArgument([string]$Value) {
    return 'utf8hex:' + [Convert]::ToHexString([Text.Encoding]::UTF8.GetBytes($Value)).ToLowerInvariant()
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$pathsJson = ConvertTo-Json -InputObject @($ObfPath | ForEach-Object { [IO.Path]::GetFullPath($_) }) -Compress
$arguments = @(
    '--export-admin-boundaries',
    (ConvertTo-Utf8HexArgument $pathsJson),
    (ConvertTo-Utf8HexArgument ([IO.Path]::GetFullPath($ResourcesRoot))),
    (ConvertTo-Utf8HexArgument $resolvedOutput),
    $Latitude.ToString('R', [Globalization.CultureInfo]::InvariantCulture),
    $Longitude.ToString('R', [Globalization.CultureInfo]::InvariantCulture),
    $RadiusKm.ToString('R', [Globalization.CultureInfo]::InvariantCulture),
    (ConvertTo-Utf8HexArgument 'en')
)

& $HelperPath @arguments
if ($LASTEXITCODE -ne 0) {
    throw "OBF boundary GPX export failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) {
    throw "The helper reported success but the GPX file was not created: $resolvedOutput"
}

Write-Host "GPX export created: $resolvedOutput"
