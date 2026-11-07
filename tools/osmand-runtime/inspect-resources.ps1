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

$source = (Resolve-Path -LiteralPath $ResourcesSource).Path
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "ResourcesSource is not a directory: $ResourcesSource"
}

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

$files = [System.Collections.Generic.List[object]]::new()
foreach ($directory in $resolvedDirectories) {
    Get-ChildItem -LiteralPath $directory.FullPath -File -Recurse | ForEach-Object {
        $relativePath = [IO.Path]::GetRelativePath($source, $_.FullName).Replace('\', '/')
        $files.Add([pscustomobject]@{
            Path = $relativePath
            Extension = $_.Extension.ToLowerInvariant()
            Length = $_.Length
            Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        })
    }
}

$licenseSearchRoots = [System.Collections.Generic.List[string]]::new()
$licenseSearchRoots.Add($source)
if ($LicenseRoot) {
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
    Files = @($files | Sort-Object Path)
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
