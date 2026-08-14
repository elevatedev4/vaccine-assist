<#
.SYNOPSIS
    One-click update + build + launch for the Vaccine Assist desktop app.

.DESCRIPTION
    Adapted from rx-verify's update-and-run.ps1 (~/claude/rx-verify/update-and-run.ps1)
    for this repo's layout: this script lives in desktop\ (a subfolder of
    the vaccine-assist monorepo, alongside cloud\ and supabase\), not at
    the repo root, so step 1 below walks upward to find the actual git
    repo root instead of assuming $PSScriptRoot IS the repo root.

    There is no Node/npm build step here (unlike rx-verify, which pairs a
    TypeScript matching engine with its overlay) — cloud\ is a separate
    Next.js app deployed to Vercel, not something a pharmacy workstation
    builds or runs locally. This script only builds and launches the WPF
    desktop project.

    Every run:
      1. Self-locates the repo root by walking up from this script's own
         folder ($PSScriptRoot) until a .git folder is found - no
         hardcoded path, works whether the repo is at \claude\vaccine-assist,
         \vaccine-assist, or anywhere else.
      2. git fetch origin + git checkout -f -B main origin/main - forces
         the local `main` branch to exactly match GitHub's `main`,
         regardless of local drift. GitHub is the source of truth on
         deploy-and-test machines, so this intentionally discards local
         modifications.
      3. Before building: stops any running VaccineAssist.Desktop.exe whose
         path is under THIS checkout's own bin\Debug directory (never a
         same-named process from a different checkout) - gracefully
         (CloseMainWindow, then a short wait, then Stop-Process -Force if
         it's still up) - so `dotnet build` doesn't fail trying to
         overwrite a running exe (MSB3026).
      4. dotnet build (desktop\VaccineAssist.Desktop) - ALWAYS runs, every
         invocation. No staleness guesswork; dotnet's incremental build
         makes repeat runs fast once warm.
      5. Launches the freshly built .exe, which then attempts one silent
         auto-login using %LocalAppData%\VaccineAssist\autologin.json if
         bootstrap-fresh.ps1 (repo root) seeded it - see that script and
         ViewModels/LoginViewModel.cs (TryAutoSignInAsync).

    Any failed step (git fetch/checkout, a running app that won't stop,
    dotnet build, or not finding the built .exe) prints exactly which step
    failed, then holds the window open with "Press Enter to close" so the
    error is readable even when this was launched via double-click. On
    success, it just launches and exits.

    PowerShell 5.1 compatible on purpose (Windows' default) - no PS7-only
    syntax (ternary, ??, &&/||, Join-Path -AdditionalChildPath, etc.).

.NOTES
    SYNTHETIC DATA ONLY applies to this repo as a whole - this script
    itself never touches patient data, only source code and build
    artifacts. Local app settings (Supabase URL/keys) live at
    %AppData%\VaccineAssist\settings.json, untouched by this script.
#>

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor DarkGray
}

function Write-ErrorBlock {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

function Stop-WithMessage {
    param([string]$Message)
    Write-ErrorBlock $Message
    Write-ErrorBlock 'Copy the text above (including any error output) and send it to Will/dev. Nothing has been changed or discarded.'
    Read-Host 'Press Enter to close this window'
    exit 1
}

# Runs a native command, capturing merged stdout+stderr, WITHOUT letting
# git/dotnet status text on stderr trip $ErrorActionPreference='Stop' into
# a fake NativeCommandError. The command's exit code is the real signal;
# callers check $LASTEXITCODE afterward.
function Invoke-NativeCapture {
    param([Parameter(Mandatory)][scriptblock]$Command)
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Command 2>&1
        $script:NativeExitCode = $LASTEXITCODE
        return $output
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

# ---------------------------------------------------------------------
# Step 1: find the repo root by walking up from this script's own folder
# until a .git folder turns up. This script lives in desktop\, not the
# repo root, so (unlike rx-verify's script) $PSScriptRoot itself is NOT
# the repo root.
# ---------------------------------------------------------------------
$RepoRoot = $PSScriptRoot
while ($RepoRoot -and -not (Test-Path (Join-Path $RepoRoot '.git'))) {
    $parent = Split-Path -Parent $RepoRoot
    if ($parent -eq $RepoRoot -or [string]::IsNullOrEmpty($parent)) {
        $RepoRoot = $null
        break
    }
    $RepoRoot = $parent
}

if (-not $RepoRoot) {
    Stop-WithMessage "Could not find a .git folder above $PSScriptRoot. Re-clone the vaccine-assist repo (see README.md) and run this script from inside desktop\."
}

Set-Location -Path $RepoRoot

# ---------------------------------------------------------------------
# Step 2: sync to origin/main - forces the local `main` branch to exactly
# match GitHub's `main` every run, same reasoning as rx-verify's script.
# ---------------------------------------------------------------------
Write-Step "Syncing to latest from GitHub (origin/main)..."
$fetchOutput = Invoke-NativeCapture { git fetch origin }
$fetchExitCode = $script:NativeExitCode
$fetchOutput | ForEach-Object { Write-Detail "$_" }
if ($fetchExitCode -ne 0) {
    Stop-WithMessage "git fetch origin failed in $RepoRoot. Check the network connection and try again."
}

$checkoutOutput = Invoke-NativeCapture { git checkout -f -B main origin/main }
$checkoutExitCode = $script:NativeExitCode
$checkoutOutput | ForEach-Object { Write-Detail "$_" }
if ($checkoutExitCode -ne 0) {
    Stop-WithMessage "git checkout -f -B main origin/main failed in $RepoRoot. The local checkout could not be synced to match GitHub's main branch."
}

# ---------------------------------------------------------------------
# Step 3: dotnet build - ALWAYS runs. Incremental under the hood, so
# there's never a stale .exe to debug.
# ---------------------------------------------------------------------
$desktopProjectDir = Join-Path $RepoRoot 'desktop\VaccineAssist.Desktop'
if (-not (Test-Path $desktopProjectDir)) {
    Stop-WithMessage "Desktop project folder not found at $desktopProjectDir. The repo checkout looks incomplete or corrupted."
}

$binDebugDir = Join-Path $desktopProjectDir 'bin\Debug'
# Trailing-separator-normalized form used for the StartsWith() prefix
# checks below - without the trailing '\', "...\bin\Debug" would also
# match an unrelated sibling folder like "...\bin\DebugOld" that merely
# starts with the same characters.
$binDebugDirPrefix = $binDebugDir.TrimEnd('\') + '\'

function Find-DesktopExe {
    if (-not (Test-Path $binDebugDir)) { return $null }
    $found = Get-ChildItem -Path $binDebugDir -Filter 'VaccineAssist.Desktop.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $found) { return $null }
    return $found.FullName
}

# ---------------------------------------------------------------------
# Step 3a: stop a running instance of this app before rebuilding it.
# `dotnet build` fails with MSB3026 ("Could not copy apphost.exe ...
# because it is being used by another process") if the exe it's about to
# overwrite is currently running — without this, re-running the shortcut
# or the one-liner (bootstrap-fresh.ps1) while Vaccine Assist is still
# open turns into a build-failure retry loop instead of a clean update.
# Only ever stops a VaccineAssist.Desktop.exe whose path is under THIS
# checkout's own bin\Debug dir ($binDebugDir, built from $RepoRoot above)
# — never a same-named process from a different checkout/location.
# Mirrors rx-verify's update-and-run.ps1 (~/claude/rx-verify) stop-before-
# build pattern, minus its extra "close an old-location copy too" step
# (W-T67-specific to rx-verify, not asked for here).
# ---------------------------------------------------------------------
# .HasExited (like .Path below) can throw — eg. a Win32Exception on an
# access-denied/elevation-mismatch process. With $ErrorActionPreference =
# 'Stop' that would crash the whole script before Stop-WithMessage ever
# runs — on the double-click path, a window that just vanishes with no
# message. Treat "can't tell" as "still running": it falls through to the
# Stop-Process -Force attempt and then the final re-check below, both of
# which already report a real failure loudly.
function Test-ProcessStillRunning {
    param($Process)
    try {
        $Process.Refresh()
        return (-not $Process.HasExited)
    } catch {
        return $true
    }
}

$appProcessName = 'VaccineAssist.Desktop'
$runningAppProcesses = Get-Process -Name $appProcessName -ErrorAction SilentlyContinue
$processesToStop = @()
foreach ($proc in $runningAppProcesses) {
    # .Path (MainModule.FileName under the hood) can throw — eg. access
    # denied for an elevated process while this script runs non-elevated,
    # or a process that exited between Get-Process and here. Treat
    # "couldn't determine" the same as "different location": never stop
    # something we can't positively confirm is our own exe.
    $procPath = $null
    try {
        $procPath = $proc.Path
    } catch {
        $procPath = $null
    }

    if (($procPath -ne $null) -and $procPath.StartsWith($binDebugDirPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $processesToStop += $proc
    }
}

if ($processesToStop.Count -gt 0) {
    Write-Step 'Stopping the running Vaccine Assist app so it can be updated...'
    foreach ($proc in $processesToStop) {
        Write-Detail "Stopping VaccineAssist.Desktop.exe (PID $($proc.Id))..."
        try {
            $proc.CloseMainWindow() | Out-Null
        } catch {
            # No message loop / already gone — fall through to the
            # wait-then-force-kill below regardless.
        }

        $waited = 0
        while ($waited -lt 5) {
            if (-not (Test-ProcessStillRunning $proc)) { break }
            Start-Sleep -Seconds 1
            $waited++
        }

        if (Test-ProcessStillRunning $proc) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                Start-Sleep -Seconds 1
            } catch {
                # Failure is caught by the still-running re-check below.
            }
        }
    }

    $stillRunning = @(Get-Process -Name $appProcessName -ErrorAction SilentlyContinue | Where-Object {
        $stillPath = $null
        try { $stillPath = $_.Path } catch { $stillPath = $null }
        ($stillPath -ne $null) -and $stillPath.StartsWith($binDebugDirPrefix, [StringComparison]::OrdinalIgnoreCase)
    })

    if ($stillRunning.Count -gt 0) {
        $stillPids = ($stillRunning | ForEach-Object { $_.Id }) -join ', '
        Stop-WithMessage "Vaccine Assist (PID(s): $stillPids) is still running and could not be stopped automatically. Close it by hand - right-click its window/taskbar icon and close, or End Task in Task Manager - then re-run this script."
    }
    Write-Detail 'Vaccine Assist stopped.'
}

Write-Step 'Building Vaccine Assist (dotnet build)...'
Push-Location $desktopProjectDir
try {
    dotnet build
    $buildExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($buildExitCode -ne 0) {
    Stop-WithMessage "dotnet build failed in $desktopProjectDir (see the error above)."
}

$exePath = Find-DesktopExe
if (($exePath -eq $null) -or (-not (Test-Path $exePath))) {
    Stop-WithMessage "dotnet build succeeded but VaccineAssist.Desktop.exe was not found anywhere under $binDebugDir (searched recursively for bin\Debug\net8.0-windows\VaccineAssist.Desktop.exe). Something is wrong with the build output path."
}

# ---------------------------------------------------------------------
# Step 4: launch.
# ---------------------------------------------------------------------
Write-Step "Launching Vaccine Assist ($exePath)..."
try {
    Start-Process -FilePath $exePath -WorkingDirectory (Split-Path -Path $exePath -Parent)
} catch {
    Stop-WithMessage "Failed to launch $exePath. Error: $($_.Exception.Message)"
}
