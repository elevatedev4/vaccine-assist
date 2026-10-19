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
    TypeScript matching engine with its overlay) - cloud\ is a separate
    Next.js app deployed to Vercel, not something a pharmacy workstation
    builds or runs locally. This script only builds and launches the WPF
    desktop project.

    Version channels (Will, 2026-10-18): "It is vital that the app works at
    all times." Git refs are the versions:
      * `stable`        - latest known-good. THE DEFAULT. The desktop shortcut
                          passes no arguments, so every normal start builds
                          and runs origin/stable in the primary checkout.
                          If origin/stable does not exist yet this falls
                          back to origin/main (the old behavior).
      * `testing/<slug>` - opt-in testing versions, picked from the app's
                          Version menu (-Ref testing/<slug>). Built and run
                          from a separate git worktree folder beside the
                          primary checkout (<checkout>-testing), so the
                          stable checkout and its binaries are never
                          touched. If the testing build fails for any
                          reason, the reason is printed and stable is built
                          and launched instead - the user is never left
                          with no app.
    The script ALWAYS operates on the primary checkout, even when it is
    started from the testing worktree's copy of this file.

    Every run:
      1. Self-locates the primary checkout (walks up from this script's
         folder to a .git; a linked worktree resolves back to its primary).
      2. (-WaitForPid only) waits for the app that asked for a switch to
         exit on its own, up to 20 seconds.
      3. git fetch origin.
      4. Stable: git checkout -f -B stable origin/stable (or main if there is
         no stable branch yet) in the primary checkout - GitHub is the
         source of truth on deploy-and-test machines, so this intentionally
         discards local modifications.
         Testing: create/reset the <checkout>-testing worktree to
         origin/<ref> (detached HEAD).
      5. Stops any running VaccineAssist.Desktop.exe from EITHER folder's
         bin\Debug (gracefully, then forced, then waits until it has really
         exited) so `dotnet build` can overwrite the exe and the single-
         instance mutex is free. A same-named process from anywhere else is
         never touched.
      6. dotnet build (desktop\VaccineAssist.Desktop) - ALWAYS runs - with
         the ref, short commit SHA and primary checkout path stamped into
         the build (-p:VaBuildRef / VaBuildCommit / VaPrimaryRoot), which
         the app uses for its window title and Version menu.
      7. Launches the freshly built .exe, which then attempts one silent
         auto-login using %LocalAppData%\VaccineAssist\autologin.json if
         bootstrap-fresh.ps1 (repo root) seeded it - see that script and
         ViewModels/LoginViewModel.cs (TryAutoSignInAsync).

    Any failed stable step (git fetch/checkout, a running app that won't
    stop, dotnet build, or not finding the built .exe) prints exactly which
    step failed, then holds the window open with "Press Enter to close" so
    the error is readable even when this was launched via double-click. On
    success, it just launches and exits.

.PARAMETER Ref
    Which version to run: `stable` (default) or `testing/<slug>`.

.PARAMETER WaitForPid
    Process id of the running app that is switching versions; the script
    waits (up to 20 s) for it to exit before touching anything. Passed by the
    app's Version menu, not by the shortcut.

    PowerShell 5.1 compatible on purpose (Windows' default) - no PS7-only
    syntax (ternary, ??, &&/||, Join-Path -AdditionalChildPath, etc.).

.NOTES
    SYNTHETIC DATA ONLY applies to this repo as a whole - this script
    itself never touches patient data, only source code and build
    artifacts. Local app settings (Supabase URL/keys) live at
    %AppData%\VaccineAssist\settings.json, untouched by this script.
#>

[CmdletBinding()]
param(
    # Which version to run: 'stable' (default - what the desktop shortcut
    # gets, since it passes no arguments) or 'testing/<slug>'.
    [string]$Ref = 'stable',

    # Pid of the running app that is asking for the switch (see .PARAMETER).
    [int]$WaitForPid = 0
)

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

# V-T21 item 8 (Will, 2026-09-08): a visible "Updating..." line the
# instant the shortcut/one-liner runs, before anything else (repo-root
# lookup, git, dotnet build) even starts - so a double-click clearly shows
# "something happened" right away, distinct from Write-Step's own
# "Syncing to latest from GitHub..." a moment later. No other behavior in
# this script changes.
Write-Host 'Updating Vaccine Assist...' -ForegroundColor Cyan

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
# Pure helpers (no I/O). desktop\tests\check-launcher.ps1 extracts these by
# name and asserts them in CI, so keep them self-contained.
# ---------------------------------------------------------------------

# Only two kinds of ref are ever launched: 'stable' or 'testing/<slug>'
# (one path segment of letters, digits, '.', '_', '-'; \z, not $, so a
# trailing newline cannot slip through). Windows device names (con, aux,
# nul, com1, ...) are refused: they cannot be created as ref files there.
function Test-LaunchableRef {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value)) { return $false }
    if ($Value -ceq 'stable') { return $true }
    if ($Value -cnotmatch '^testing/[A-Za-z0-9][A-Za-z0-9._-]*\z') { return $false }
    if ($Value.Contains('..') -or $Value.EndsWith('.lock') -or $Value.EndsWith('.')) { return $false }
    $slug = $Value.Substring('testing/'.Length)
    $baseName = $slug.Split('.')[0].ToLowerInvariant()
    if ($baseName -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])\z') { return $false }
    return $true
}

# A short commit id for -p:VaBuildCommit, or 'unknown' when the text is
# anything else (e.g. a git warning that landed on the same stream).
function Get-SafeCommit {
    param([string]$Raw)

    $text = "$Raw".Trim()
    if ($text -cmatch '^[0-9a-f]{4,40}\z') { return $text }
    return 'unknown'
}

# True when a value is safe to pass as an MSBuild -p:Name=Value. ';' would
# start a second property, '%' an escape, '*' '?' wildcards, '$' '@' item/
# property syntax, '"' breaks quoting, ',' splits some switches.
function Test-SafeStampValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    if ($Value -match '[;"%*?$@,\r\n\t]') { return $false }
    return $true
}

if (-not (Test-LaunchableRef $Ref)) {
    Stop-WithMessage "Unsupported -Ref '$Ref'. Use 'stable' or 'testing/<name>'."
}

# ---------------------------------------------------------------------
# Locate the PRIMARY checkout. This script lives in desktop\, so walk up to
# the nearest .git. If that .git is a FILE the script is running from a
# linked worktree (the <checkout>-testing folder): its first line reads
# "gitdir: <primary>/.git/worktrees/<name>", which leads back to the primary
# checkout. Everything below operates on the primary checkout, no matter
# which copy of this file was started.
# ---------------------------------------------------------------------
function Find-PrimaryRoot {
    param([string]$StartDir)

    $dir = $StartDir
    while ($dir -and -not (Test-Path (Join-Path $dir '.git'))) {
        $up = Split-Path -Parent $dir
        if ($up -eq $dir -or [string]::IsNullOrEmpty($up)) { return $null }
        $dir = $up
    }
    if (-not $dir) { return $null }

    $gitEntry = Join-Path $dir '.git'
    if (Test-Path $gitEntry -PathType Container) {
        return $dir
    }

    # Linked worktree: .git is a file.
    $firstLine = Get-Content -Path $gitEntry -TotalCount 1
    if ($firstLine -match '^gitdir:\s*(.+)$') {
        $gitDir = ($Matches[1].Trim()) -replace '/', '\'
        $worktreesDir = Split-Path -Parent $gitDir          # <primary>\.git\worktrees
        $dotGitDir = Split-Path -Parent $worktreesDir       # <primary>\.git
        if ((Split-Path -Leaf $worktreesDir) -eq 'worktrees' -and (Split-Path -Leaf $dotGitDir) -eq '.git') {
            $candidate = Split-Path -Parent $dotGitDir
            if (Test-Path (Join-Path $candidate '.git') -PathType Container) { return $candidate }
        }
    }

    # Fallback: <primary>-testing -> <primary>
    if ($dir.EndsWith('-testing')) {
        $candidate = $dir.Substring(0, $dir.Length - '-testing'.Length)
        if (Test-Path (Join-Path $candidate '.git') -PathType Container) { return $candidate }
    }
    return $null
}

$PrimaryRoot = Find-PrimaryRoot -StartDir $PSScriptRoot
if (-not $PrimaryRoot) {
    Stop-WithMessage "Could not find the primary vaccine-assist checkout above $PSScriptRoot. Re-clone the vaccine-assist repo (see README.md) and run this script from inside desktop\."
}
$TestingRoot = $PrimaryRoot.TrimEnd('\') + '-testing'
$isTesting = $Ref.StartsWith('testing/')

Set-Location -Path $PrimaryRoot

# ---------------------------------------------------------------------
# Switching from inside the running app: let it finish exiting on its own
# (releases the hotkeys, tray icon and single-instance mutex cleanly)
# before this script touches anything. Bounded; anything still running
# after this is stopped below.
# ---------------------------------------------------------------------
if ($WaitForPid -gt 0) {
    $asker = Get-Process -Id $WaitForPid -ErrorAction SilentlyContinue
    if ($asker) {
        Write-Step 'Waiting for Vaccine Assist to close...'
        $null = $asker.WaitForExit(20000)
    }
}

# ---------------------------------------------------------------------
# Process handling: stop any VaccineAssist.Desktop.exe running from one of
# the given checkout folders' bin\Debug (never a same-named process from
# anywhere else), then wait until it has actually exited.
# ---------------------------------------------------------------------
$appProcessName = 'VaccineAssist.Desktop'

# .HasExited (like .Path) can throw - eg. a Win32Exception on an
# access-denied/elevation-mismatch process. Treat "can't tell" as "still
# running": it falls through to the force-stop attempt and the final
# re-check, which report a real failure loudly.
function Test-ProcessStillRunning {
    param($Process)
    try {
        $Process.Refresh()
        return (-not $Process.HasExited)
    } catch {
        return $true
    }
}

function Get-AppProcessesUnder {
    param([string[]]$Roots)

    $prefixes = @()
    foreach ($root in $Roots) {
        # Trailing '\' so "...\bin\Debug" never matches a sibling like "...\bin\DebugOld".
        $prefixes += ((Join-Path $root 'desktop\VaccineAssist.Desktop\bin\Debug').TrimEnd('\') + '\')
    }

    $found = @()
    foreach ($proc in @(Get-Process -Name $appProcessName -ErrorAction SilentlyContinue)) {
        # .Path can throw (access denied / process exited): "couldn't
        # determine" is treated as "different location" - never stop
        # something not positively confirmed to be ours.
        $procPath = $null
        try { $procPath = $proc.Path } catch { $procPath = $null }
        if ($procPath -eq $null) { continue }
        foreach ($prefix in $prefixes) {
            if ($procPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                $found += $proc
                break
            }
        }
    }
    return $found
}

# Throws (does not exit) if something could not be stopped, so the caller
# decides: stable stops with a message, testing falls back to stable.
function Stop-DesktopApps {
    param([string[]]$Roots)

    $toStop = @(Get-AppProcessesUnder -Roots $Roots)
    if ($toStop.Count -eq 0) { return }

    Write-Step 'Stopping the running Vaccine Assist app so it can be updated...'
    foreach ($proc in $toStop) {
        Write-Detail "Stopping VaccineAssist.Desktop.exe (PID $($proc.Id))..."
        try { $proc.CloseMainWindow() | Out-Null } catch { }

        $waited = 0
        while ($waited -lt 5) {
            if (-not (Test-ProcessStillRunning $proc)) { break }
            Start-Sleep -Seconds 1
            $waited++
        }

        if (Test-ProcessStillRunning $proc) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            } catch {
                # Caught by the re-check below.
            }
            # Wait until it has REALLY exited (releases the mutex + the exe file lock).
            try { $null = $proc.WaitForExit(10000) } catch { }
        }
    }

    $stillRunning = @(Get-AppProcessesUnder -Roots $Roots | Where-Object { Test-ProcessStillRunning $_ })
    if ($stillRunning.Count -gt 0) {
        $stillPids = ($stillRunning | ForEach-Object { $_.Id }) -join ', '
        throw "Vaccine Assist (PID(s): $stillPids) is still running and could not be stopped automatically. Close it by hand - right-click its window/taskbar icon and close, or End Task in Task Manager - then re-run this script."
    }
    Write-Detail 'Vaccine Assist stopped.'
}

function Find-DesktopExe {
    param([string]$BinDebugDir)
    if (-not (Test-Path $BinDebugDir)) { return $null }
    $found = Get-ChildItem -Path $BinDebugDir -Filter 'VaccineAssist.Desktop.exe' -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -eq $found) { return $null }
    return $found.FullName
}

# dotnet build ALWAYS runs (incremental under the hood, so there is never a
# stale .exe to debug). Stamps ref + short commit + primary checkout path
# into the build. Returns the built exe path; throws on any failure.
function Invoke-DesktopBuild {
    param([string]$Root, [string]$BuildRef)

    $projectDir = Join-Path $Root 'desktop\VaccineAssist.Desktop'
    if (-not (Test-Path $projectDir)) {
        throw "Desktop project folder not found at $projectDir. The checkout looks incomplete or corrupted."
    }

    $shaOutput = Invoke-NativeCapture { git -C $Root rev-parse --short HEAD }
    $commit = 'unknown'
    if ($script:NativeExitCode -eq 0) {
        foreach ($line in @($shaOutput)) {
            $candidate = Get-SafeCommit "$line"
            if ($candidate -ne 'unknown') { $commit = $candidate; break }
        }
    }

    # Stamp values are only passed when safe; a bad one is omitted (the
    # app then shows "unstamped"/unknown for it) rather than breaking the build.
    $buildArgs = @('build', "-p:VaBuildRef=$BuildRef")
    if ($commit -ne 'unknown') { $buildArgs += "-p:VaBuildCommit=$commit" }
    if (Test-SafeStampValue $PrimaryRoot) { $buildArgs += "-p:VaPrimaryRoot=$PrimaryRoot" }
    else { Write-Detail 'Primary checkout path has characters MSBuild cannot take as a property; not stamping it.' }

    Write-Step "Building Vaccine Assist ($BuildRef @ $commit) (dotnet build)..."
    Push-Location $projectDir
    try {
        & dotnet @buildArgs | Out-Host
        $buildExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($buildExitCode -ne 0) {
        throw "dotnet build failed in $projectDir (exit code $buildExitCode; see the error above)."
    }

    $binDebugDir = Join-Path $projectDir 'bin\Debug'
    $exePath = Find-DesktopExe -BinDebugDir $binDebugDir
    if (($exePath -eq $null) -or (-not (Test-Path $exePath))) {
        throw "dotnet build succeeded but VaccineAssist.Desktop.exe was not found anywhere under $binDebugDir (searched recursively for bin\Debug\net8.0-windows\VaccineAssist.Desktop.exe). Something is wrong with the build output path."
    }
    return $exePath
}

function Start-DesktopApp {
    param([string]$ExePath)
    Write-Step "Launching Vaccine Assist ($ExePath)..."
    Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Path $ExePath -Parent)
}

# Creates (or resets) the <checkout>-testing worktree at origin/<ref> and
# returns its path. Detached HEAD, so it never competes with the primary
# checkout for a branch. A worktree folder that git no longer recognizes
# (e.g. its admin dir under .git\worktrees is gone after a re-clone) is
# removed, pruned and re-created ONCE. Throws on failure.
function Update-TestingWorktree {
    param([string]$TestingRef)

    $remoteRef = "refs/remotes/origin/$TestingRef"
    $null = Invoke-NativeCapture { git -C $PrimaryRoot rev-parse --verify --quiet $remoteRef }
    if ($script:NativeExitCode -ne 0) {
        throw "The branch origin/$TestingRef was not found on GitHub (was it deleted?)."
    }

    $healthy = $false
    if (Test-Path (Join-Path $TestingRoot '.git')) {
        $null = Invoke-NativeCapture { git -C $TestingRoot rev-parse --git-dir }
        $healthy = ($script:NativeExitCode -eq 0)
        if ($healthy) {
            Write-Step "Updating the testing worktree to origin/$TestingRef..."
            $coOutput = Invoke-NativeCapture { git -C $TestingRoot checkout -f --detach $remoteRef }
            $coCode = $script:NativeExitCode
            $coOutput | ForEach-Object { Write-Detail "$_" }
            if ($coCode -eq 0) { return $TestingRoot }
            Write-Detail 'Checkout in the existing testing worktree failed; re-creating it.'
        } else {
            Write-Detail 'The testing worktree folder is no longer a valid git worktree; re-creating it.'
        }
    }

    for ($attempt = 1; $attempt -le 2; $attempt++) {
        # Whatever is at this path is not a usable worktree (checked above);
        # only ever removes the derived <checkout>-testing folder.
        if ((Test-Path $TestingRoot) -and $TestingRoot.EndsWith('-testing')) {
            Remove-Item -LiteralPath $TestingRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        $null = Invoke-NativeCapture { git -C $PrimaryRoot worktree prune }
        Write-Step "Creating the testing worktree ($TestingRoot)..."
        $addOutput = Invoke-NativeCapture { git -C $PrimaryRoot worktree add --detach --force $TestingRoot $remoteRef }
        $addCode = $script:NativeExitCode
        $addOutput | ForEach-Object { Write-Detail "$_" }
        if ($addCode -eq 0) { return $TestingRoot }
    }
    throw "git worktree add failed for $TestingRoot (tried twice, after removing the folder and pruning)."
}

# ---------------------------------------------------------------------
# Fetching. Only what is needed is fetched - never every branch - so an
# odd testing/* branch name (a Windows device name, a case collision, a
# trailing dot) cannot make the loose-ref creation of an unrelated branch
# fail and take the stable launch down with it. --prune drops remote-
# tracking refs of branches deleted on GitHub.
# ---------------------------------------------------------------------
function Update-StableRefs {
    # Both branches in one go; if `stable` does not exist on GitHub yet that
    # fails as a whole, so fall back to `main` alone (pre-channels behavior).
    $out = Invoke-NativeCapture { git fetch --prune origin stable main }
    if ($script:NativeExitCode -eq 0) { return $true }
    $out | ForEach-Object { Write-Detail "$_" }
    $out = Invoke-NativeCapture { git fetch --prune origin main }
    $out | ForEach-Object { Write-Detail "$_" }
    return ($script:NativeExitCode -eq 0)
}

function Update-TestingRef {
    param([string]$TestingRef)

    $refspec = "+refs/heads/${TestingRef}:refs/remotes/origin/${TestingRef}"
    $out = Invoke-NativeCapture { git fetch --prune origin $refspec }
    $code = $script:NativeExitCode
    $out | ForEach-Object { Write-Detail "$_" }
    if ($code -ne 0) {
        # Deleted on GitHub: drop the stale remote-tracking ref so it cannot be picked again.
        if ((@($out) -join "`n") -match "couldn't find remote ref") {
            $null = Invoke-NativeCapture { git update-ref -d "refs/remotes/origin/$TestingRef" }
        }
        throw "git fetch of origin/$TestingRef failed (the branch may have been deleted, or GitHub is unreachable)."
    }
}

# The exe currently built under the primary checkout's bin\Debug, with its
# size and timestamp, so a launch whose update step fails can fall back to
# it - but only if the failed step did not touch it.
function Get-ExeSnapshot {
    $path = Find-DesktopExe -BinDebugDir (Join-Path $PrimaryRoot 'desktop\VaccineAssist.Desktop\bin\Debug')
    if (($path -eq $null) -or (-not (Test-Path $path))) { return $null }
    $item = Get-Item -LiteralPath $path
    return @{ Path = $path; Length = $item.Length; Ticks = $item.LastWriteTimeUtc.Ticks }
}

# Update failed (offline, bad fetch, failed build): start the previously
# built app instead of leaving no app. A failed compile never reaches the
# copy-to-bin step, so bin\Debug still holds the last good build; if the
# exe's size/timestamp changed anyway, it is not trusted. No usable exe =
# the old behavior (message + hold the window open).
function Start-PreviousBuildOrStop {
    param([string]$Reason, $Snapshot)

    $usable = $false
    if ($Snapshot -ne $null -and (Test-Path -LiteralPath $Snapshot.Path)) {
        $now = Get-Item -LiteralPath $Snapshot.Path
        $usable = ($now.Length -eq $Snapshot.Length) -and ($now.LastWriteTimeUtc.Ticks -eq $Snapshot.Ticks)
    }
    if (-not $usable) {
        Stop-WithMessage $Reason
    }

    Write-ErrorBlock ''
    Write-ErrorBlock "$Reason"
    Write-ErrorBlock 'Starting the previously installed version instead.'
    try {
        Stop-DesktopApps -Roots @($PrimaryRoot, $TestingRoot)
        Start-DesktopApp -ExePath $Snapshot.Path
    } catch {
        Stop-WithMessage "$Reason Starting the previous version also failed: $($_.Exception.Message)"
    }
    Read-Host 'Press Enter to close this window'
    exit 0
}

# ---------------------------------------------------------------------
# Step 1 (testing only): build + run the testing worktree. ANY failure
# prints why and falls through to the stable path below, so the user is
# never left with no app. The stable checkout is not touched here.
# ---------------------------------------------------------------------
$testingFailure = $null
if ($isTesting) {
    try {
        Write-Step "Syncing with GitHub (origin/$Ref)..."
        Update-TestingRef -TestingRef $Ref
        # The previous copy of THIS testing build must not hold its own files open.
        Stop-DesktopApps -Roots @($TestingRoot)
        $worktreePath = Update-TestingWorktree -TestingRef $Ref
        $testingExe = Invoke-DesktopBuild -Root $worktreePath -BuildRef $Ref
        # Built OK: now free the single-instance mutex (stable or testing
        # copy, whichever is running) and start the testing build.
        Stop-DesktopApps -Roots @($PrimaryRoot, $TestingRoot)
        Start-DesktopApp -ExePath $testingExe
        exit 0
    } catch {
        $testingFailure = $_.Exception.Message
        Write-ErrorBlock ''
        Write-ErrorBlock "The testing version ($Ref) could not be started:"
        Write-ErrorBlock "  $testingFailure"
        Write-ErrorBlock 'Falling back to the Stable version...'
        Write-Host ''
    }
}

# ---------------------------------------------------------------------
# Step 2: stable. Forces the primary checkout's `stable` branch to exactly
# match GitHub's, every run. Until the stable branch exists on GitHub this
# falls back to `main` (the behavior before version channels existed).
# If GitHub cannot be reached, or the sync/build fails, the previously
# built app is started instead (see Start-PreviousBuildOrStop).
# ---------------------------------------------------------------------
$previousExe = Get-ExeSnapshot

Write-Step 'Syncing with GitHub...'
if (-not (Update-StableRefs)) {
    Start-PreviousBuildOrStop -Reason "git fetch origin failed in $PrimaryRoot (offline, or GitHub unreachable)." -Snapshot $previousExe
}

try {
    $null = Invoke-NativeCapture { git rev-parse --verify --quiet refs/remotes/origin/stable }
    $stableBranch = if ($script:NativeExitCode -eq 0) { 'stable' } else { 'main' }
    if ($stableBranch -eq 'main') {
        Write-Detail 'No origin/stable branch yet - using origin/main.'
    }

    Write-Step "Syncing to latest from GitHub (origin/$stableBranch)..."
    $checkoutOutput = Invoke-NativeCapture { git checkout -f -B $stableBranch "origin/$stableBranch" }
    $checkoutExitCode = $script:NativeExitCode
    $checkoutOutput | ForEach-Object { Write-Detail "$_" }
    if ($checkoutExitCode -ne 0) {
        throw "git checkout -f -B $stableBranch origin/$stableBranch failed in $PrimaryRoot. The local checkout could not be synced to match GitHub's $stableBranch branch."
    }

    Stop-DesktopApps -Roots @($PrimaryRoot, $TestingRoot)
    $stableExe = Invoke-DesktopBuild -Root $PrimaryRoot -BuildRef $stableBranch
    Start-DesktopApp -ExePath $stableExe
} catch {
    Start-PreviousBuildOrStop -Reason $_.Exception.Message -Snapshot $previousExe
}

if ($testingFailure) {
    # Stable is running; keep the window open so the reason above can be read.
    Write-ErrorBlock ''
    Write-ErrorBlock "Stable Vaccine Assist has been started. The testing version ($Ref) failed: $testingFailure"
    Read-Host 'Press Enter to close this window'
}
