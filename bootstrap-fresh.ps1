<#
.SYNOPSIS
    Fresh-Windows-PC bootstrap AND every-day launcher for Vaccine Assist,
    in one pasteable command: installs Git and the .NET 8 SDK via winget
    if missing, clones the repo, seeds the shared pharmacy login, then
    hands off to desktop\update-and-run.ps1 to build and launch — signed
    in, no prompts.

.DESCRIPTION
    Meant to be run from an interactive PowerShell console by pasting the
    one-liner from README.md, which downloads this script's text and
    invokes it as a scriptblock (NOT `iex` — this script takes
    parameters, and `irm ... | iex` has no way to pass any):

        [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/elevatedev4/vaccine-assist/main/bootstrap-fresh.ps1))) -Email you@orchardsdrug.com -Password "the-shared-password" -ServerUrl https://your-vaccine-assist-cloud.vercel.app

    This is the ONE line for both cases Will asked for:
      - Fresh PC, nothing installed yet → full install + clone + shortcut
        + seed login + build + run.
      - Already set up (re-run any time, e.g. after a fix ships, or just
        as the daily "open the app" command) → every step below detects
        "already done" and skips straight to syncing + rebuilding +
        launching, still ending signed in.
    There's no separate "just run it" variant to remember — paste the
    exact same line either way.

    Because it runs via a downloaded scriptblock rather than a script
    file on disk — not launched as its own process the way
    update-and-run.ps1 and install-shortcut.ps1 are (via
    `powershell -File ...`) — two things that are safe in those scripts
    are NOT safe here:

      - $PSScriptRoot is empty/unavailable (there is no script file on
        disk to locate). Every path below is built explicitly from
        $env:USERPROFILE / $env:APPDATA / $env:LOCALAPPDATA instead.
      - `exit` would close Will's actual PowerShell window, not just this
        script, since the scriptblock runs in his current session rather
        than a child process. Every failure path below uses `throw`
        instead, caught by the try/catch at the bottom, so a failure
        prints a clear message and hands control back to Will's prompt -
        the window stays open either way.

    Steps:

      1. Checks for winget (Get-Command winget). If missing, tells Will
         to install "App Installer" from the Microsoft Store and re-run.
      2. Installs Git and the .NET 8 SDK via winget, each only if it
         isn't already present AND working — Test-GitOk/Test-Dotnet8Ok
         below actually invoke the tool (git --version / dotnet
         --list-sdks) inside a try/catch rather than trusting
         Get-Command alone, so a corrupted/quarantined binary that still
         resolves on PATH is treated the same as "missing" and
         reinstalled, instead of this script silently limping forward.
         Skipped entirely when already present and working - so any
         non-zero exit code winget itself returns is a real failure, not
         an "already installed" false alarm - every non-zero winget exit
         code stops the script.
      3. If anything was installed, refreshes PATH in this console
         session from the Machine + User environment so newly-installed
         tools resolve without reopening PowerShell, then re-verifies. If
         a tool still doesn't resolve (some installers need a genuinely
         fresh console despite the refresh), tells Will to close and
         reopen PowerShell and paste the same one-liner again - installs
         already done are kept, so it picks up where it left off.
      4. Clones the repo to the canonical path,
         $env:USERPROFILE\claude\vaccine-assist, if it isn't already
         there. "Already there" is judged by desktop\update-and-run.ps1
         existing inside it, not just the folder existing - a folder with
         no update-and-run.ps1 means a previous clone was interrupted,
         and the script throws with the exact command to remove that
         broken copy rather than silently retrying over it or deleting it
         itself.
      5. Creates/refreshes the "Vaccine Assist" Desktop shortcut by
         invoking desktop\install-shortcut.ps1 from inside the
         freshly-cloned repo, so a fresh PC ends fully set up - not just
         installed-and-run-once, but ready for every future launch to be
         a single double-click too. install-shortcut.ps1 also makes a
         best-effort attempt to pin that shortcut to the taskbar (Windows
         has no supported API for a script to do this reliably - see that
         script's header for why - so it either pins successfully on
         Windows builds that still allow it, or prints a one-line "pin it
         yourself" fallback; either way it never fails this step).
         Non-fatal if this whole step fails (eg. some COM oddity creating
         the .lnk): a warning is printed and the script continues, since
         the app can still be run directly via update-and-run.ps1 below
         (or by pasting this same one-liner again), and
         install-shortcut.ps1 can always be re-run by hand later.
      6. Seeds/updates %AppData%\VaccineAssist\settings.json with this
         app's fixed Supabase project URL + anon key (the same values
         every pharmacy workstation uses - hardcoded as $SupabaseUrl/
         $SupabaseAnonKey below; the anon key is designed to be public-
         safe, same exposure model as the cloud app's own
         NEXT_PUBLIC_SUPABASE_ANON_KEY - see cloud/.env.example) and, if
         -ServerUrl was passed, the cloud API base URL. Only rewrites the
         file when a value is actually missing or different, so re-runs
         don't needlessly touch it.
      7. If both -Email and -Password were passed, seeds/updates
         %LocalAppData%\VaccineAssist\autologin.json with those
         credentials - %LocalAppData% (non-roaming), deliberately
         different from step 6's %AppData% (roaming) settings.json, so a
         plaintext shared-login password never rides along in a roaming
         profile. Only written when missing or when the passed
         Email/Password differ from what's already stored - re-running
         the same one-liner doesn't needlessly rewrite it. If -Email/
         -Password are omitted, any existing autologin.json is left
         untouched (the app still tries it at startup); if none exists
         either, the app just shows its normal manual login form - never
         a crash, never a required prompt from this script.
      8. Hands off to desktop\update-and-run.ps1 (sync + build + launch)
         via `powershell -ExecutionPolicy Bypass -File ...`, the same
         command the "every run after" workflow in README.md uses. Since
         fresh PCs default to a Restricted execution policy,
         -ExecutionPolicy Bypass is required for that handoff to run at
         all. update-and-run.ps1 now also verifies Git/dotnet are present
         on its own, plus stops any already-running instance of the app
         before rebuilding it, so this handoff is safe even on a re-run
         while Vaccine Assist is already open. Once launched, the app
         itself performs the actual sign-in using the autologin.json from
         step 7 (see ViewModels/LoginViewModel.cs,
         TryAutoSignInAsync) - this script's job ends at "launched",
         not "logged in", since that last step happens inside the .NET
         process, not PowerShell.

    Windows PowerShell 5.1 compatible on purpose (Windows' default) - no
    PS7-only syntax (ternary, ??, &&/||, Join-Path -AdditionalChildPath,
    etc.).

.NOTES
    No PHI anywhere in this system (see README.md) - this script itself
    only installs tooling, clones/builds source code, and seeds
    non-clinical login/config values (a shared pharmacy Supabase Auth
    login, a public-safe Supabase anon key, a Cloud API URL). Nothing it
    touches is patient data.
#>

param(
    [string]$Email = '',
    [string]$Password = '',
    [string]$ServerUrl = ''
)

function Write-Step {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Message)
    Write-Host "  $Message" -ForegroundColor DarkGray
}

# Same corrupted-binary-aware presence checks update-and-run.ps1 uses for
# dotnet - applied here to git too, per the brief for this script. A
# binary that resolves via Get-Command but is corrupted (bad install, AV
# quarantine, a missing DLL) throws when actually invoked rather than
# returning a clean non-zero exit code; routing that through "return
# $false" sends it through the same reinstall/re-check/throw machinery as
# a plain missing tool instead of crashing this whole scriptblock.
function Test-GitOk {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
    try {
        git --version | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Test-Dotnet8Ok {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { return $false }
    try {
        $installedSdks = dotnet --list-sdks
        foreach ($line in $installedSdks) {
            if ($line -like '8.*') { return $true }
        }
        return $false
    } catch {
        return $false
    }
}

# Sets a property on a PSCustomObject only if the value is actually
# different (or the property doesn't exist yet), preserving every other
# property already on the object (forward-compatible with any future
# settings.json fields this script doesn't know about). Returns $true
# when it changed something.
function Set-IfDifferentJsonProperty {
    param($Object, [string]$Name, [string]$Value)
    $prop = $Object.PSObject.Properties[$Name]
    $existing = $null
    if ($null -ne $prop) { $existing = $prop.Value }
    if ($existing -eq $Value) { return $false }
    if ($null -ne $prop) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
    }
    return $true
}

function Invoke-VaccineAssistBootstrap {
    # Scoped to THIS function only (PowerShell preference variables are
    # function-scoped) so it never bleeds into Will's interactive session
    # after this script finishes running.
    $ErrorActionPreference = 'Stop'

    $RepoUrl = 'https://github.com/elevatedev4/vaccine-assist.git'
    $ClaudeDir = Join-Path $env:USERPROFILE 'claude'
    $RepoPath = Join-Path $ClaudeDir 'vaccine-assist'
    $LauncherScriptPath = Join-Path $RepoPath 'desktop\update-and-run.ps1'
    $InstallShortcutScriptPath = Join-Path $RepoPath 'desktop\install-shortcut.ps1'

    # This app's one fixed Supabase project - same for every pharmacy
    # workstation, not per-user/per-machine, so it's a script constant
    # rather than a -Parameter. The anon key is meant to be public-safe
    # (same exposure model as any client-side Supabase app - RLS is what
    # actually gates access, and this desktop app never queries Postgrest
    # directly anyway; see desktop/README.md "How auth + data flow fit
    # together"), unlike the service-role key/DB password, which never
    # appear in this script or anywhere the desktop app can read them.
    $SupabaseUrl = 'https://ajfpghrqiwmokhracico.supabase.co'
    $SupabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqZnBnaHJxaXdtb2tocmFjaWNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzY2NzcsImV4cCI6MjEwMjIxMjY3N30.w1gh1JARY_NX3zLMNZzT63Ma8Lm0ELT5bWYg6OEXvNI'

    # -------------------------------------------------------------
    # Step 0: winget itself must exist - everything below depends on it.
    # -------------------------------------------------------------
    Write-Step 'Checking for winget (Windows Package Manager)...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget not found. Open the Microsoft Store, install "App Installer", reopen PowerShell, then paste the one-liner again.'
    }
    Write-Detail 'winget found.'

    Write-Host 'Windows may show a few Yes/No install prompts below - click Yes. It may also show a UAC "Do you want to allow this app to make changes to your device?" dialog - click Yes on that too.' -ForegroundColor Yellow

    $anyInstalled = $false

    # -------------------------------------------------------------
    # Step 1: Git
    # -------------------------------------------------------------
    Write-Step 'Checking for Git...'
    if (Test-GitOk) {
        Write-Detail 'Git already installed - skipping.'
    } else {
        Write-Detail 'Git missing or not working - installing via winget (Git.Git)...'
        winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "winget install -e --id Git.Git failed (exit code $LASTEXITCODE). See the winget output above for details."
        }
        $anyInstalled = $true
    }

    # -------------------------------------------------------------
    # Step 2: .NET 8 SDK
    # -------------------------------------------------------------
    Write-Step 'Checking for .NET 8 SDK...'
    if (Test-Dotnet8Ok) {
        Write-Detail '.NET 8 SDK already installed - skipping.'
    } else {
        Write-Detail '.NET 8 SDK missing or not working - installing via winget (Microsoft.DotNet.SDK.8)...'
        winget install -e --id Microsoft.DotNet.SDK.8 --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            throw "winget install -e --id Microsoft.DotNet.SDK.8 failed (exit code $LASTEXITCODE). See the winget output above for details."
        }
        $anyInstalled = $true
    }

    # -------------------------------------------------------------
    # Step 3: if anything was installed, refresh PATH in this console
    # session, then re-verify everything resolves before moving on.
    # -------------------------------------------------------------
    if ($anyInstalled) {
        Write-Step 'Refreshing PATH in this session...'
        $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $machinePath) { $machinePath = '' }
        if ($null -eq $userPath) { $userPath = '' }
        $env:Path = $machinePath + ';' + $userPath

        $stillMissing = @()
        if (-not (Test-GitOk)) { $stillMissing += 'git' }
        if (-not (Test-Dotnet8Ok)) { $stillMissing += 'dotnet (.NET 8 SDK)' }

        if ($stillMissing.Count -gt 0) {
            $missingList = $stillMissing -join ', '
            throw "Installed OK, but this PowerShell window still can't see: $missingList. Close this PowerShell window, reopen a new one, and paste the same one-liner again - the installs are kept, so it will pick up where it left off."
        }
        Write-Detail 'git and dotnet both resolve in this session.'
    }

    # -------------------------------------------------------------
    # Step 4: clone if missing. "Already cloned" is judged by
    # $LauncherScriptPath existing (a file only present after a
    # completed checkout), NOT by the .git folder existing - git creates
    # .git almost immediately, before the object transfer or checkout
    # finishes, so a clone interrupted mid-transfer still leaves a .git
    # folder behind. Trusting .git alone would make this script report
    # "already cloned" forever on a broken copy and never recover. This
    # script never deletes anything on its own - it tells Will exactly
    # what to remove and how, rather than guessing.
    # -------------------------------------------------------------
    Write-Step "Checking for the repo at $RepoPath..."
    if (Test-Path $LauncherScriptPath) {
        Write-Detail 'Repo already cloned - skipping.'
    } elseif (Test-Path $RepoPath) {
        throw "A partial or broken copy of the repo already exists at $RepoPath - there's no desktop\update-and-run.ps1 inside it, which means a previous clone got interrupted before it finished. It holds no local work of yours, just an incomplete download, so it's safe to remove. Run this, then paste the one-liner again:`n`n  Remove-Item -Recurse -Force `"$RepoPath`"`n"
    } else {
        if (-not (Test-Path $ClaudeDir)) {
            New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
        }
        Write-Detail "Cloning $RepoUrl to $RepoPath..."
        git clone $RepoUrl $RepoPath
        if ($LASTEXITCODE -ne 0) {
            throw "git clone $RepoUrl $RepoPath failed (exit code $LASTEXITCODE). See the git output above for details."
        }
    }

    if (-not (Test-Path $LauncherScriptPath)) {
        throw "$LauncherScriptPath still doesn't exist after cloning - something is wrong with the repo checkout."
    }

    # -------------------------------------------------------------
    # Step 5: create/refresh the Desktop shortcut so a fresh PC ends
    # fully set up. install-shortcut.ps1 is idempotent (overwrites any
    # existing shortcut, never duplicates) - safe to run on every
    # bootstrap, including re-runs on an already-set-up PC. -NoPrompt
    # suppresses its interactive "Press Enter to close" pause, which only
    # makes sense when it's run standalone/by hand. Deliberately
    # non-fatal: a failure here shouldn't block getting the app running
    # for the first time (step 8 below still runs either way), and this
    # can always be re-run later (see desktop/README.md).
    # -------------------------------------------------------------
    Write-Step 'Creating/refreshing the Desktop shortcut...'
    powershell -ExecutionPolicy Bypass -File "$InstallShortcutScriptPath" -NoPrompt
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Could not create the Desktop shortcut (exit code $LASTEXITCODE) - continuing anyway. Re-run desktop\install-shortcut.ps1 later to try again." -ForegroundColor Yellow
    } else {
        Write-Detail 'Desktop shortcut ready.'
    }

    # -------------------------------------------------------------
    # Step 6: seed/update %AppData%\VaccineAssist\settings.json with the
    # fixed Supabase project + (if passed) the cloud API URL. Reads the
    # existing file first (if any) so unrelated fields - eg.
    # LastSignedInEmail, or anything a future version adds - survive
    # untouched; only rewrites the file when something actually changed.
    # -------------------------------------------------------------
    Write-Step 'Checking local app settings (%AppData%\VaccineAssist\settings.json)...'
    $SettingsPath = Join-Path $env:APPDATA 'VaccineAssist\settings.json'
    $settingsDir = Split-Path -Path $SettingsPath -Parent
    if (-not (Test-Path $settingsDir)) {
        New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
    }

    $settingsObj = $null
    if (Test-Path $SettingsPath) {
        try {
            $settingsObj = Get-Content -Path $SettingsPath -Raw | ConvertFrom-Json
        } catch {
            $settingsObj = $null
        }
    }
    if ($null -eq $settingsObj) {
        $settingsObj = [PSCustomObject]@{}
    }

    $settingsChanged = $false
    if (Set-IfDifferentJsonProperty -Object $settingsObj -Name 'SupabaseUrl' -Value $SupabaseUrl) { $settingsChanged = $true }
    if (Set-IfDifferentJsonProperty -Object $settingsObj -Name 'SupabaseAnonKey' -Value $SupabaseAnonKey) { $settingsChanged = $true }
    if (-not [string]::IsNullOrWhiteSpace($ServerUrl)) {
        if (Set-IfDifferentJsonProperty -Object $settingsObj -Name 'CloudApiBaseUrl' -Value $ServerUrl) { $settingsChanged = $true }
    }

    if ($settingsChanged) {
        Write-Detail 'Updating settings.json (Supabase config and/or Cloud API URL changed)...'
        ($settingsObj | ConvertTo-Json -Depth 5) | Set-Content -Path $SettingsPath -Encoding UTF8
    } else {
        Write-Detail 'settings.json already up to date - skipping.'
    }

    # -------------------------------------------------------------
    # Step 7: seed/update %LocalAppData%\VaccineAssist\autologin.json
    # ONLY when both -Email and -Password were passed - never overwrites
    # (or deletes) an existing autologin.json when they weren't. Skips
    # the write when the stored values already match, so re-pasting the
    # same one-liner doesn't needlessly rewrite the file.
    # -------------------------------------------------------------
    Write-Step 'Checking auto-login config (%LocalAppData%\VaccineAssist\autologin.json)...'
    if (-not [string]::IsNullOrWhiteSpace($Email) -and -not [string]::IsNullOrWhiteSpace($Password)) {
        $AutoLoginPath = Join-Path $env:LOCALAPPDATA 'VaccineAssist\autologin.json'
        $autoLoginDir = Split-Path -Path $AutoLoginPath -Parent
        if (-not (Test-Path $autoLoginDir)) {
            New-Item -ItemType Directory -Path $autoLoginDir -Force | Out-Null
        }

        $existingAutoLogin = $null
        if (Test-Path $AutoLoginPath) {
            try {
                $existingAutoLogin = Get-Content -Path $AutoLoginPath -Raw | ConvertFrom-Json
            } catch {
                $existingAutoLogin = $null
            }
        }

        $needsWrite = $true
        if (($null -ne $existingAutoLogin) -and ($existingAutoLogin.Email -ceq $Email) -and ($existingAutoLogin.Password -ceq $Password)) {
            $needsWrite = $false
        }

        if ($needsWrite) {
            Write-Detail 'Writing auto-login config (none stored yet, or the passed Email/Password differ from what is stored)...'
            $autoLoginObj = [PSCustomObject]@{ Email = $Email; Password = $Password }
            ($autoLoginObj | ConvertTo-Json) | Set-Content -Path $AutoLoginPath -Encoding UTF8
        } else {
            Write-Detail 'Auto-login config already up to date - skipping.'
        }
    } else {
        Write-Detail 'No -Email/-Password passed - leaving any existing auto-login config untouched (the app falls back to its normal manual login form).'
    }

    # -------------------------------------------------------------
    # Step 8: hand off to desktop\update-and-run.ps1 (sync + build +
    # launch). It handles its own errors (holds the window open on
    # failure), so this is the last thing this script does either way.
    # The launched app performs the actual sign-in itself using the
    # autologin.json seeded above, if any.
    # -------------------------------------------------------------
    Write-Step 'Handing off to desktop\update-and-run.ps1 (sync + build + launch)...'
    powershell -ExecutionPolicy Bypass -File "$LauncherScriptPath"
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-VaccineAssistBootstrap
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Copy the text above (including any error output) and send it to Will/dev. Nothing destructive has happened - any tools already installed, and any settings/auto-login files already seeded, are kept, so pasting the same one-liner again later will pick up where it left off. If the error above was about a partial repo copy, run the exact command it gave you first, then paste the one-liner again.' -ForegroundColor Red
}
