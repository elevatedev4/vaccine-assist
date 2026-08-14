<#
.SYNOPSIS
    One-time setup: creates a "Vaccine Assist" Desktop shortcut that runs
    update-and-run.ps1 - after this, updating/building/launching the app
    is a single double-click, and it behaves identically to pasting the
    repo root's bootstrap-fresh.ps1 one-liner again (both roads lead to
    the same update-and-run.ps1).

.DESCRIPTION
    Normally run automatically by bootstrap-fresh.ps1 (repo root) as part
    of the one-liner, right after the repo is cloned - see that script's
    header. Can also be run by hand (right-click -> Run with PowerShell,
    or from a PowerShell prompt inside desktop\) to (re)create the
    shortcut without going through the full bootstrap, eg. if the
    shortcut got deleted.

    Unlike rx-verify's install-shortcut.ps1 (~/claude/rx-verify), this
    script does NOT clone the repo itself if missing - it self-locates
    the repo root the same way desktop\update-and-run.ps1 does, by
    walking up from its own folder ($PSScriptRoot) until a .git folder
    turns up, since it's meant to always be run from inside an existing
    checkout (bootstrap-fresh.ps1 already guarantees the clone happens
    before ever calling this script).

      1. Confirms it's running from inside a real vaccine-assist checkout
         (a .git folder above this script) and that
         desktop\update-and-run.ps1 exists there.
      2. Creates (or overwrites - safe to re-run any time) a Desktop
         shortcut named "Vaccine Assist" that runs:
           powershell -ExecutionPolicy Bypass -File "<repo root>\desktop\update-and-run.ps1"
      3. Makes a best-effort attempt to pin that shortcut to the Windows
         taskbar. Microsoft removed the supported way to do this from a
         script (the shell "Pin to taskbar" verb was blocked starting
         Windows 10 1903, and Windows 11 is stricter still - there is no
         supported per-app pinning API; it's a genuine user action or
         MDM/provisioning-only). This never fails the script either way:
         if the verb exists on this Windows build, it's invoked and you
         get a one-line "pinned" confirmation; if not (the common case on
         current Windows 10/11), you get a one-line instruction to
         right-click the Desktop shortcut and pin it yourself, once.

    -ExecutionPolicy Bypass on the shortcut's own invocation only affects
    that one process - it does not change your machine's PowerShell
    execution policy setting.

    Pass -NoPrompt to skip the "Press Enter to close this window" pauses
    below (both on success and on failure). Only meant for when this
    script is invoked programmatically - bootstrap-fresh.ps1 does this to
    create/refresh the shortcut as part of a fresh-PC bootstrap that
    shouldn't stop and wait for a keypress partway through. Run it
    directly (double-click, or "Run with PowerShell") and the pauses stay
    on, same as always.

    PowerShell 5.1 compatible on purpose (Windows' default).
#>

param(
    [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Stop-WithMessage {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
    Write-Host 'Copy the text above (including any error output) and send it to Will/dev. Nothing has been changed or discarded.' -ForegroundColor Red
    if (-not $NoPrompt) { Read-Host 'Press Enter to close this window' }
    exit 1
}

# ---------------------------------------------------------------------
# Step 1: find the repo root by walking up from this script's own folder
# until a .git folder turns up - same approach as update-and-run.ps1
# (this script also lives in desktop\, not the repo root).
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
    Stop-WithMessage "Could not find a .git folder above $PSScriptRoot. This script expects to live inside desktop\ of a real vaccine-assist checkout - re-clone the repo (see README.md) and run it from there."
}

$LauncherScriptPath = Join-Path $RepoRoot 'desktop\update-and-run.ps1'
if (-not (Test-Path $LauncherScriptPath)) {
    Stop-WithMessage "$LauncherScriptPath doesn't exist - the repo checkout at $RepoRoot looks incomplete or corrupted."
}

# ---------------------------------------------------------------------
# Step 2: create (or overwrite) the Desktop shortcut. WScript.Shell is
# the standard classic-COM way to make a .lnk from PowerShell and has
# worked unchanged since PS2 - no PS7-only cmdlet needed.
# ---------------------------------------------------------------------
Write-Step 'Creating Desktop shortcut "Vaccine Assist"...'

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Vaccine Assist.lnk'
$powershellExePath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellExePath
$shortcut.Arguments = '-ExecutionPolicy Bypass -File "' + $LauncherScriptPath + '"'
$shortcut.WorkingDirectory = Split-Path -Path $LauncherScriptPath -Parent
$shortcut.IconLocation = $powershellExePath + ',0'
$shortcut.Description = 'Update and launch Vaccine Assist'
$shortcut.Save()

# ---------------------------------------------------------------------
# Step 3: best-effort pin to taskbar. There is no supported, documented
# API for an app to pin its own shortcut to the Windows taskbar -
# Microsoft blocked the shell "Pin to taskbar" verb from programmatic
# invocation starting with Windows 10 1903, specifically to stop exactly
# this kind of script from doing it; Windows 11 is stricter still, with
# pinning treated as a genuine user action (or an MDM/provisioning-time
# operation, not something a normal install script can reach). What
# follows is a good-faith attempt using the same Shell.Application COM
# verb-enumeration approach that still works on some older/edge-case
# Windows builds where that verb wasn't fully locked down: ask the shell
# for the shortcut's context-menu verbs and look for one that pins to the
# taskbar (name match is loose/case-insensitive since wording varies by
# locale and Windows build - "Pin to tas&kbar", "Pin to taskbar", etc.),
# invoke it if present. The verb match explicitly excludes anything
# matching "unpin" - some Windows builds also expose an "Unpin from
# taskbar" verb once already pinned, and matching "taskbar" alone would
# grab that instead and immediately undo a previous pin. Deliberately NOT
# a registry/explorer-restart hack - those are fragile and can kill
# Explorer mid-script; this only ever calls a documented COM
# verb-invoke method, and the whole thing is wrapped in try/catch so a
# throw here can never fail the overall shortcut-creation script - worst
# case, the user is told to pin it by hand once.
# ---------------------------------------------------------------------
Write-Step 'Attempting to pin "Vaccine Assist" to the taskbar...'
$pinned = $false
try {
    $shellApp = New-Object -ComObject Shell.Application
    $shortcutFolder = $shellApp.Namespace($desktopPath)
    $shortcutItem = $shortcutFolder.ParseName((Split-Path -Path $shortcutPath -Leaf))
    if ($null -ne $shortcutItem) {
        $pinVerb = $null
        foreach ($verb in $shortcutItem.Verbs()) {
            $verbName = $verb.Name -replace '&', ''
            if (($verbName -match '(?i)taskbar') -and ($verbName -notmatch '(?i)unpin')) {
                $pinVerb = $verb
                break
            }
        }
        if ($null -ne $pinVerb) {
            $pinVerb.DoIt()
            $pinned = $true
        }
    }
} catch {
    $pinned = $false
}

if ($pinned) {
    Write-Step 'Pinned "Vaccine Assist" to the taskbar.'
} else {
    Write-Host "Windows doesn't allow apps to pin for you on this version - right-click the desktop 'Vaccine Assist' shortcut and choose 'Pin to taskbar' (one time)." -ForegroundColor Yellow
}

Write-Step "Done. '$shortcutPath' now syncs, builds fresh, and launches Vaccine Assist (signed in, if auto-login is seeded) in one double-click."
if (-not $NoPrompt) { Read-Host 'Press Enter to close this window' }
