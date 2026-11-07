# PowerShell 7 wird für die OsmAnd-Stage-Skripte benötigt.
# Bei Aufruf aus Windows PowerShell 5.1 den Build automatisch in pwsh fortsetzen.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $pwshCommand = Get-Command "pwsh.exe" -ErrorAction SilentlyContinue
    if (-not $pwshCommand) {
        throw "PowerShell 7 wurde nicht gefunden. Bitte PowerShell 7 installieren und 'pwsh' verfügbar machen."
    }

    & $pwshCommand.Source -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
    exit $LASTEXITCODE
}


$workBranch = "main"
$ErrorActionPreference = "Stop"

# Projektverzeichnis = Verzeichnis dieser PS1-Datei
$projectDir = $PSScriptRoot
Set-Location $projectDir

Write-Host "`n=== LumaScope Build in $projectDir ===" -ForegroundColor Cyan
# Write-Host "Projekt: $projectDir"

#############################################################################
# Hilfsfunktion: Native Befehle mit Fehlerpr�fung ausf�hren
function Invoke-CheckedCommand {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan

    & $Command @Arguments

    if ($LASTEXITCODE -ne 0) {
        throw "$Command wurde mit Fehlercode $LASTEXITCODE beendet."
    }
}


#############################################################################
# Projektbezogene Prozesse und deren temporaere Verzeichnisse bereinigen


function StopProcesses {
    Write-Host "`n=== Projektbezogene Prozesse beenden ($projectDir) ===" -ForegroundColor Yellow

    # Alle Prozesse ermitteln, deren Kommandozeile auf dieses Projekt verweist
    $nodes = Get-CimInstance Win32_Process

    $excludedProcessNames = @(
        'devenv.exe'
        'cmd.exe'
    )

    $matchingNodes = @(
        $nodes | Where-Object {
            $_.ProcessId -ne $PID -and
            $_.Name -notin $excludedProcessNames -and
            $_.CommandLine -and
            $_.CommandLine.IndexOf(
                $projectDir,
                [StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        }
    )

    $processIds = @(
        $matchingNodes |
            ForEach-Object { [int]$_.ProcessId } |
            Sort-Object -Unique
    )

    # Prozesse und deren Kindprozesse beenden
    foreach ($process in $matchingNodes) {
        $maxLineLength = 125
        $commandLine = $process.CommandLine
        $shortCommandLine = $commandLine.Substring(
            0,
            [Math]::Min($maxLineLength, $commandLine.Length)
        )
        $ellipsis = if ($commandLine.Length -gt $maxLineLength) { '...' } else { '' }

        Write-Host "STOP $($process.ProcessId) '$($process.Name)' $shortCommandLine$ellipsis" -ForegroundColor Yellow

        # /T beendet auch die Kindprozesse. Ein Elternprozess kann einen
        # zuvor ermittelten Kindprozess bereits beendet haben. taskkill meldet
        # diesen erwartbaren Race-Condition-Fall über stderr/Exitcode.
        # Beide nativen Ausgabestreams direkt verwerfen: 2>&1 reicht unter
        # PowerShell 7 nicht aus, da stderr sonst NativeCommandError auslösen kann.
        & taskkill.exe /PID $process.ProcessId /T /F 1>$null 2>$null

        if ($LASTEXITCODE -ne 0) {
            Write-Host "INFO PID $($process.ProcessId) ist bereits beendet oder nicht mehr erreichbar (taskkill: $LASTEXITCODE)." -ForegroundColor DarkGray
        }
        #Write-Host "STOPPED $($process.ProcessId) '$($process.Name)' $shortCommandLine$ellipsis" -ForegroundColor Yellow
    }


    # Kurz warten, damit Prozesse und Dateizugriffe beendet sind
    Start-Sleep -Milliseconds 500

    $tempDir = $env:TEMP


    #Write-Host ">Remove empty temporary folders with 20-character hexadecimal names"

    # Remove empty temporary folders with 20-character hexadecimal names
    Get-ChildItem -LiteralPath $env:TEMP -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^[0-9a-fA-F]{20}$' } |
        ForEach-Object {
            $entries = @(Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue)

            if ($entries.Count -eq 0) {
                Write-Host "TEMP CLEANUP $($_.FullName)" -ForegroundColor Yellow
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }


    #Write-Host ">Aktuell noch existierende Prozess-IDs ermitteln"

    # Aktuell noch existierende Prozess-IDs ermitteln
    $activeProcessIds = @{}
    Get-CimInstance Win32_Process | ForEach-Object {
        $activeProcessIds[[int]$_.ProcessId] = $true
    }


    #Write-Host ">Nur die Temp-Verzeichnisse dieser Prozess-IDs entfernen"

    # Nur die Temp-Verzeichnisse dieser Prozess-IDs entfernen
    $tempDir = $env:TEMP

    foreach ($processId in $processIds) {
        $tempPattern = "tmp-$processId-*"

        Get-ChildItem -LiteralPath $tempDir -Directory -Filter $tempPattern -ErrorAction SilentlyContinue |
            ForEach-Object {
                Write-Host "TEMP CLEANUP $($_.FullName)" -ForegroundColor Yellow
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
    }


    #Write-Host ">Node.js Temp-Verzeichnisse bereinigen"

    # Node.js Temp-Verzeichnisse bereinigen
    # Namensschema: tmp-<PID>-<random>
    Get-ChildItem -LiteralPath $tempDir -Directory -Filter 'tmp-*' -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match '^tmp-(\d+)-') {
                $tempProcessId = [int]$Matches[1]

                # Nur l�schen, wenn der zugeh�rige Prozess nicht mehr existiert
                if (-not $activeProcessIds.ContainsKey($tempProcessId)) {
                    Write-Host "TEMP NODE CLEANUP $($_.FullName)" -ForegroundColor Yellow
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }



    #Write-Host ">Verwaiste Electron-Download-Verzeichnisse entfernen"

    # Verwaiste Electron-Download-Verzeichnisse entfernen
    # Nur Verzeichnisse l�schen, die seit mindestens 10 Minuten unver�ndert sind.
    $electronCutoff = (Get-Date).AddMinutes(-10)

    Get-ChildItem -LiteralPath $tempDir -Directory -Filter 'electron-download-*' -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LastWriteTime -lt $electronCutoff
        } |
        ForEach-Object {
            Write-Host "TEMP ELECTRON CLEANUP $($_.FullName)" -ForegroundColor Yellow
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }

    #Write-Host ">StopProcesses END"
}


#############################################################################
# Hilfsfunktion: Executable-Verzeichnisse l�schen
function RemoveExecutableDirs {
    
    $buildDirs = @(
        ".\dist\executables\win-unpacked",
        ".\dist\executables\win-unpacked.tmp"
    )

    foreach ($dir in $buildDirs) {
        if (-not (Test-Path -LiteralPath $dir)) {
            continue
        }

        Write-Host "RMDIR $dir" -ForegroundColor Yellow

        $removed = $false

        for ($attempt = 1; $attempt -le 5; $attempt++) {
            try {
                Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
                $removed = $true
                break
            }
            catch {
                Write-Warning "L�schversuch $attempt fehlgeschlagen: $($_.Exception.Message)"

                if ($attempt -lt 5) {
                    Start-Sleep -Seconds 2
                }
            }
        }

        if (-not $removed -and (Test-Path -LiteralPath $dir)) {
            throw "Verzeichnis '$dir' konnte nach 5 Versuchen nicht gel�scht werden. M�glicherweise h�lt noch ein Prozess eine Datei ge�ffnet."
        }
    }
}


# Branch �berpr�fen
# Write-Host "`n=== Git Branch �berpr�fen ===" -ForegroundColor Yellow

$currentBranch = (& git branch --show-current).Trim()

if ($LASTEXITCODE -ne 0) {
    throw "Git Branch konnte nicht ermittelt werden."
}

if ($currentBranch -ne $workBranch) {
    throw "Falscher Branch: $currentBranch. Erwartet wird $workBranch."
}

# Git aktualisieren
Invoke-CheckedCommand "git" @("pull", "--ff-only", "origin", $workBranch)

Invoke-CheckedCommand "npx" @("nx", "reset")
Invoke-CheckedCommand "npm" @("run", "build:all")

# Native OsmAnd helpers and licensed resources are staged from the sibling SDK
# before packaging, so the latest Atlas renderer is included in the installer.
& (Join-Path $projectDir "tools/osmand-runtime/stage-helpers.ps1")
& (Join-Path $projectDir "tools/osmand-runtime/stage-resources.ps1")

StopProcesses
RemoveExecutableDirs

# Produktions-Build
# Nx-Daemon f�r das Packaging deaktivieren
$env:NX_DAEMON = "false"

try {
    Invoke-CheckedCommand "npx" @("nx", "run", "desktop:make")
    if ($LASTEXITCODE -ne 0) {
        throw "desktop:make wurde mit Fehlercode $LASTEXITCODE beendet."
    }
}
finally {
    Remove-Item Env:\NX_DAEMON -ErrorAction SilentlyContinue
    if ($null -eq $previousCscIdentityAutoDiscovery) {
        Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
    }
    else {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousCscIdentityAutoDiscovery
    }
}


# Fertige Anwendung starten
$exe = Join-Path $projectDir "dist\executables\win-unpacked\LumaScope.exe"

if (-not (Test-Path $exe)) {
    throw "Die fertige LumaScope.exe wurde nicht gefunden: $exe"
}

Write-Host "`n=== Starte LumaScope $exe ===" -ForegroundColor Green
Start-Process -FilePath $exe

# Write-Host "`n=== Build erfolgreich abgeschlossen ===" -ForegroundColor Green

# $exe = "C:\__Daten\Dev\__LumaScope\source\dist\executables\win-unpacked\LumaScope.exe"
# $log = "$env:TEMP\LumaScope-chrome.log"
# Remove-Item $log -Force -ErrorAction SilentlyContinue
#
# & $exe --enable-logging=file "--log-file=$log" --v=1
