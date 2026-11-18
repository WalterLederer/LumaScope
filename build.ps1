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

# Resolve Node.js once and pass its absolute path to Nx run-commands.
# This avoids relying on command-shell PATH lookup in nested Nx processes.
$nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
if (-not $nodeCommand -or -not $nodeCommand.Source) {
    throw "Node.js executable node.exe was not found. Ensure Node.js is installed and available in PATH."
}
$nodeExe = $nodeCommand.Source
Write-Host "Node.js executable: $nodeExe" -ForegroundColor DarkGray

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


function Write-ShutdownDiagnostic {
    param(
        [string]$Event,
        [hashtable]$Details = @{}
    )

    $timestamp = [DateTimeOffset]::Now.ToString("dd.MM.yyyy, HH:mm:ss.fff")
    $record = [ordered]@{
        timestampLocal = $timestamp
        timezone = [TimeZoneInfo]::Local.Id
        event = $Event
        buildProcessId = $PID
        details = $Details
    }
    $line = $record | ConvertTo-Json -Compress -Depth 6
    $diagnosticPath = Join-Path $env:TEMP "LumaScope-build-shutdown.log"
    Add-Content -LiteralPath $diagnosticPath -Value $line -Encoding utf8
    Write-Host "SHUTDOWN DIAGNOSTIC $line" -ForegroundColor DarkGray
}

function StopProcesses {
    # Rekursive Temp-Bereinigung ohne separate, den Build-Output ueberlagernde Fortschrittsanzeige.
    $ProgressPreference = 'SilentlyContinue'

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

    # Ask Windows to close the main window using the same system-close
    # command used by the taskbar's window Close action. CloseMainWindow()
    # posts WM_CLOSE, which has not consistently triggered LumaScope's fast
    # normal shutdown path. Electron child processes must not receive
    # independent close attempts.
    if (-not ([System.Management.Automation.PSTypeName]'LumaScopeWindowClose').Type) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LumaScopeWindowClose {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    public static uint GetOwnerProcessId(IntPtr hWnd) {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        return processId;
    }

    public static string GetTitle(IntPtr hWnd) {
        StringBuilder text = new StringBuilder(1024);
        GetWindowText(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static IntPtr[] GetTopLevelWindows() {
        List<IntPtr> handles = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            handles.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return handles.ToArray();
    }
}
'@
    }
    $wmSysCommand = 0x0112
    $scClose = 0xF060
    $lumaScopeMainProcesses = @(
        $matchingNodes |
            Where-Object { $_.Name -ieq 'LumaScope.exe' } |
            ForEach-Object {
                try {
                    $process = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
                    if ($process.MainWindowHandle -ne 0) {
                        $process
                    }
                }
                catch {
                    Write-Host "INFO LumaScope PID $($_.ProcessId) already exited: $($_.Exception.Message)" -ForegroundColor DarkGray
                }
            }
    )

    foreach ($process in $lumaScopeMainProcesses) {
        $processId = [int]$process.Id
        try {
            $process.Refresh()

            # MainWindowHandle can point to an auxiliary Electron window (for
            # example LOCATION). Enumerate all visible top-level windows owned by
            # this PID and prefer the actual application window over LOCATION.
            $ownedWindows = @(
                [LumaScopeWindowClose]::GetTopLevelWindows() |
                    ForEach-Object {
                        $handle = [IntPtr]$_
                        if ([LumaScopeWindowClose]::GetOwnerProcessId($handle) -eq [uint32]$processId -and
                            [LumaScopeWindowClose]::IsWindowVisible($handle)) {
                            $title = [LumaScopeWindowClose]::GetTitle($handle)
                            if (-not [string]::IsNullOrWhiteSpace($title)) {
                                [pscustomobject]@{ Handle = $handle; Title = $title }
                            }
                        }
                    }
            )
            $mainWindow = $ownedWindows |
                Where-Object {
                    $_.Title.StartsWith('LumaScope', [StringComparison]::OrdinalIgnoreCase) -and
                    -not $_.Title.TrimEnd().EndsWith('LOCATION', [StringComparison]::OrdinalIgnoreCase)
                } |
                Select-Object -First 1

            if (-not $mainWindow) {
                $mainWindow = $ownedWindows |
                    Where-Object { $_.Title.StartsWith('LumaScope', [StringComparison]::OrdinalIgnoreCase) } |
                    Select-Object -First 1
            }

            Write-ShutdownDiagnostic "close-request-start" @{
                processId = $processId
                windows = @($ownedWindows | ForEach-Object {
                    @{ handle = ('0x{0:X}' -f $_.Handle.ToInt64()); title = $_.Title }
                })
                selectedWindow = if ($mainWindow) { $mainWindow.Title } else { $null }
            }

            if (-not $mainWindow) {
                Write-ShutdownDiagnostic "no-visible-lumascope-window" @{ processId = $processId }
                Write-Warning "No visible LumaScope window found for PID $processId; skipping graceful close."
                continue
            }

            $windowHandle = [IntPtr]$mainWindow.Handle
            $closePosted = [LumaScopeWindowClose]::PostMessage(
                $windowHandle,
                [uint32]$wmSysCommand,
                [IntPtr]$scClose,
                [IntPtr]::Zero
            )
            $postError = if ($closePosted) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
            Write-ShutdownDiagnostic "close-request-posted" @{
                processId = $processId
                closePosted = $closePosted
                win32Error = $postError
            }

            # Poll the process instead of one opaque 30-second wait. This records
            # whether the main process remains alive/responding after Windows accepts
            # the SC_CLOSE message, and the last observed top-level window state.
            $closedNormally = $false
            $elapsedSeconds = 0
            while ($closePosted -and $elapsedSeconds -lt 30) {
                if ($process.WaitForExit(1000)) {
                    $closedNormally = $true
                    break
                }
                $elapsedSeconds++
                if (($elapsedSeconds % 5) -eq 0) {
                    try {
                        $process.Refresh()
                        Write-ShutdownDiagnostic "close-wait-heartbeat" @{
                            processId = $processId
                            elapsedSeconds = $elapsedSeconds
                            hasExited = $process.HasExited
                            responding = $process.Responding
                            mainWindowHandle = ('0x{0:X}' -f $process.MainWindowHandle.ToInt64())
                            mainWindowTitle = $process.MainWindowTitle
                        }
                    }
                    catch {
                        Write-ShutdownDiagnostic "close-wait-process-query-failed" @{
                            processId = $processId
                            elapsedSeconds = $elapsedSeconds
                            error = $_.Exception.Message
                        }
                    }
                }
            }

            if ($closedNormally) {
                Write-ShutdownDiagnostic "process-exited-normally" @{ processId = $processId; elapsedSeconds = $elapsedSeconds }
                Write-Host "LumaScope PID $processId closed normally." -ForegroundColor DarkGray
            }
            else {
                if (-not $closePosted) {
                    Write-Warning "Could not send the taskbar-style close command to LumaScope PID $processId (Win32 error $postError)."
                }
                else {
                    Write-Warning "LumaScope PID $processId did not exit within 30 seconds; force-stopping its process tree now."
                }
                Write-ShutdownDiagnostic "graceful-close-timeout" @{
                    processId = $processId
                    elapsedSeconds = $elapsedSeconds
                    closePosted = $closePosted
                    win32Error = $postError
                }

                & taskkill.exe /PID $processId /T /F 1>$null 2>$null
                $taskkillExitCode = $LASTEXITCODE
                Write-ShutdownDiagnostic "force-stop-result" @{
                    processId = $processId
                    taskkillExitCode = $taskkillExitCode
                }
                if ($taskkillExitCode -ne 0) {
                    Write-Host "INFO PID $processId was already stopped or could not be reached (taskkill: $taskkillExitCode)." -ForegroundColor DarkGray
                }
            }
        }
        catch {
            Write-Host "INFO LumaScope PID $processId already exited: $($_.Exception.Message)" -ForegroundColor DarkGray
        }
    }

    # Refresh the process list after graceful shutdown. Only processes still
    # alive are eligible for the forced cleanup below.
    $nodes = Get-CimInstance Win32_Process
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
    # Rekursives Loeschen ohne separate Fortschrittsanzeige am unteren Terminalrand.
    $ProgressPreference = 'SilentlyContinue'

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

# Resolve Git independently of the PowerShell profile. The build may be
# relaunched with -NoProfile, where profile-only PATH additions are absent.
$gitCommand = Get-Command "git.exe" -ErrorAction SilentlyContinue
$gitExe = if ($gitCommand -and $gitCommand.Source) { $gitCommand.Source } else { $null }

if (-not $gitExe) {
    $gitCandidates = @(
        (Join-Path $env:ProgramFiles "Git\cmd\git.exe"),
        (Join-Path $env:ProgramFiles "Git\bin\git.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Git\cmd\git.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

    if ($gitCandidates.Count -gt 0) {
        $gitExe = $gitCandidates[0]
    }
}

if (-not $gitExe) {
    throw "Git wurde nicht gefunden. Bitte Git for Windows installieren oder git.exe zum systemweiten PATH hinzufügen. Erwarteter Standardpfad: '$env:ProgramFiles\Git\cmd\git.exe'."
}

Write-Host "Git executable: $gitExe" -ForegroundColor DarkGray

$currentBranch = (& $gitExe branch --show-current).Trim()

if ($LASTEXITCODE -ne 0) {
    throw "Git Branch konnte nicht ermittelt werden."
}

if ($currentBranch -ne $workBranch) {
    throw "Falscher Branch: $currentBranch. Erwartet wird $workBranch."
}

# Git aktualisieren
# Invoke-CheckedCommand "git" @("pull", "--ff-only", "origin", $workBranch)
Invoke-CheckedCommand $gitExe @("pull", "origin", $workBranch)

Invoke-CheckedCommand "npx" @("nx", "reset")
Invoke-CheckedCommand "npm" @("run", "build:all")

# First stop project processes and synchronously remove the previous package.
# Only after cleanup has fully returned, stage the OsmAnd runtime for packaging.
StopProcesses
RemoveExecutableDirs

& (Join-Path $projectDir "tools/mapsforge-renderer/stage-runtime.ps1")
& (Join-Path $projectDir "tools/osmand-runtime/stage-helpers.ps1")
& (Join-Path $projectDir "tools/valhalla-runtime/stage-helpers.ps1")


# Produktions-Build
# Nx-Daemon f�r das Packaging deaktivieren
$env:NX_DAEMON = "false"

# Preserve any caller-provided value and expose the resolved executable to Nx.
$previousLumaScopeNodeExe = $env:LUMASCOPE_NODE_EXE
$env:LUMASCOPE_NODE_EXE = $nodeExe

try {
    Invoke-CheckedCommand "npx" @("nx", "run", "desktop:make")
    if ($LASTEXITCODE -ne 0) {
        throw "desktop:make wurde mit Fehlercode $LASTEXITCODE beendet."
    }
}
finally {
    if ($null -eq $previousLumaScopeNodeExe) {
        Remove-Item Env:\LUMASCOPE_NODE_EXE -ErrorAction SilentlyContinue
    }
    else {
        $env:LUMASCOPE_NODE_EXE = $previousLumaScopeNodeExe
    }
    Remove-Item Env:\NX_DAEMON -ErrorAction SilentlyContinue
    if ($null -eq $previousCscIdentityAutoDiscovery) {
        Remove-Item Env:\CSC_IDENTITY_AUTO_DISCOVERY -ErrorAction SilentlyContinue
    }
    else {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = $previousCscIdentityAutoDiscovery
    }
}


# Verify the bundled Mapsforge Java runtime.
$mapsforgeJava = Join-Path $projectDir "dist\executables\win-unpacked\resources\mapsforge\runtime\bin\java.exe"
if (-not (Test-Path -LiteralPath $mapsforgeJava -PathType Leaf)) {
    throw "Bundled Mapsforge Java runtime is missing from the packaged application: $mapsforgeJava"
}
Write-Host "Mapsforge Java runtime package copy verified" -ForegroundColor Green

# Verify the native OsmAnd helper executable. OsmAnd resources are selected
# from an external folder by the user and are intentionally not packaged.
$packageResources = Join-Path $projectDir "dist\executables\win-unpacked\resources\osmand"
$helperPackagePath = Join-Path $packageResources "helpers\osmand_atlas_render_helper.exe"
if (-not (Test-Path -LiteralPath $helperPackagePath -PathType Leaf)) {
    throw "OsmAnd Atlas helper is missing from the packaged application: $helperPackagePath"
}

# Compare staged helper files with the packaged copy. OsmAnd resources are user-selected external data.
$stagedRuntimeRoots = @(
    @{ Name = "helpers"; Source = (Join-Path $projectDir "tools\osmand-runtime\stage\helpers"); Target = (Join-Path $packageResources "helpers") }
)
foreach ($runtimeRoot in $stagedRuntimeRoots) {
    $sourceFiles = @(Get-ChildItem -LiteralPath $runtimeRoot.Source -File -Recurse | ForEach-Object {
        [pscustomobject]@{
            RelativePath = $_.FullName.Substring($runtimeRoot.Source.Length).TrimStart('\')
            Length = $_.Length
        }
    } | Sort-Object RelativePath)
    $targetFiles = @(Get-ChildItem -LiteralPath $runtimeRoot.Target -File -Recurse | ForEach-Object {
        [pscustomobject]@{
            RelativePath = $_.FullName.Substring($runtimeRoot.Target.Length).TrimStart('\')
            Length = $_.Length
        }
    } | Sort-Object RelativePath)
    $sourceManifest = @($sourceFiles | ForEach-Object { "$($_.RelativePath)|$($_.Length)" })
    $targetManifest = @($targetFiles | ForEach-Object { "$($_.RelativePath)|$($_.Length)" })
    $differences = @(Compare-Object -ReferenceObject $sourceManifest -DifferenceObject $targetManifest)
    if ($differences.Count -gt 0) {
        throw "OsmAnd $($runtimeRoot.Name) package is incomplete: staged=$($sourceFiles.Count), packaged=$($targetFiles.Count)."
    }
    Write-Host "OsmAnd $($runtimeRoot.Name) package copy verified: $($targetFiles.Count) files" -ForegroundColor Green
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