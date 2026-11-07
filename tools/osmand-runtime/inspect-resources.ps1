[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourcesSource,

    [string]$LicenseRoot,

    [string]$ReportPath = (Join-Path $PSScriptRoot 'osmand-resource-inventory.json')
)

$ErrorActionPreference = 'Stop'

function Resolve-RequiredDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path -PathType Container)) {
        throw "Required OsmAnd resource directory is missing: $path"
    }

    return (Resolve-Path -LiteralPath $path).Path
}

if (-not (Test-Path -LiteralPath $ResourcesSource -PathType Container)) {
    throw "ResourcesSource is not a directory: $ResourcesSource"
}
$source = (Resolve-Path -LiteralPath $ResourcesSource).Path

$requiredDirectories = @(
    'rendering_styles',
    'rendering_styles/fonts',
    'rendering_styles/stubs',
    'rendering_styles/style-icons/map-icons-svg',
    'rendering_styles/style-icons/map-shaders-svg',
    'misc/icu4c'
)

$resolvedDirectories = foreach ($relative in $requiredDirectories) {
    [pscustomobject]@{
        RelativePath = $relative
        FullPath = Resolve-RequiredDirectory -Root $source -RelativePath $relative
    }
}

$filesByPath = @{}
foreach ($directory in $resolvedDirectories) {
    $items = if ($directory.RelativePath -eq 'rendering_styles') {
        Get-ChildItem -LiteralPath $directory.FullPath -File
    } else {
        Get-ChildItem -LiteralPath $directory.FullPath -File -Recurse
    }

    foreach ($item in $items) {
        $relativePath = [IO.Path]::GetRelativePath($source, $item.FullName).Replace('\', '/')
        if (-not $filesByPath.ContainsKey($relativePath)) {
            $filesByPath[$relativePath] = [pscustomobject]@{
                Path = $relativePath
                Extension = $item.Extension.ToLowerInvariant()
                Length = $item.Length
                Sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
            }
        }
    }
}
$files = @($filesByPath.Values | Sort-Object Path)

$licenseSearchRoots = [System.Collections.Generic.List[string]]::new()
$licenseSearchRoots.Add($source)
if ($LicenseRoot) {
    if (-not (Test-Path -LiteralPath $LicenseRoot -PathType Container)) {
        throw "LicenseRoot is not a directory: $LicenseRoot"
    }
    $licenseSearchRoots.Add((Resolve-Path -LiteralPath $LicenseRoot).Path)
}

$licenseFiles = [System.Collections.Generic.List[object]]::new()
foreach ($root in ($licenseSearchRoots | Select-Object -Unique)) {
    Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^(?i)(LICENSE|LICENCE|COPYING|NOTICE)([-_. ].*)?$'
        } |
        ForEach-Object {
            $licenseFiles.Add([pscustomobject]@{
                Path = $_.FullName
                Length = $_.Length
                Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            })
        }
}

$styles = @(
    $files |
        Where-Object { $_.Path -match '^rendering_styles/[^/]+\.render\.xml$' } |
        Sort-Object Path
)

$report = [ordered]@{
    GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
    SourceRoot = $source
    RequiredDirectories = @($resolvedDirectories | ForEach-Object { $_.RelativePath })
    RenderingStyles = $styles
    LicenseFiles = @($licenseFiles | Sort-Object Path -Unique)
    Files = $files
    FileCount = $files.Count
    TotalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    Notice = 'Inventory only. No resources are copied or approved for redistribution by this script.'
}

$reportDirectory = Split-Path -Parent $ReportPath
if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8

Write-Host "OsmAnd resource inventory created: $ReportPath"
Write-Host "Files: $($report.FileCount)"
Write-Host "Total size: $([math]::Round($report.TotalBytes / 1MB, 2)) MiB"
Write-Host "Rendering styles: $($styles.Count)"
Write-Host "License/notice files found: $($licenseFiles.Count)"
Write-Host 'No files were copied.'
