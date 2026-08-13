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
      3. dotnet build (desktop\VaccineAssist.Desktop) - ALWAYS runs, every
         invocation. No staleness guesswork; dotnet's incremental build
         makes repeat runs fast once warm.
      4. Launches the freshly built .exe.

    Any failed step (git fetch/checkout, dotnet build, or not finding the
    built .exe) prints exactly which step failed, then holds the window
    open with "Press Enter to close" so the error is readable even when
    this was launched via double-click. On success, it just launches and
    exits.

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

function Find-DesktopExe {
    if (-not (Test-Path $binDebugDir)) { return $null }
    $found = Get-ChildItem -Path $binDebugDir -Filter 'VaccineAssist.Desktop.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $found) { return $null }
    return $found.FullName
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
