# Vaccine Assist — desktop

WPF (.NET 8) app for the pharmacy workstation. Screens: Login, Vaccines (what
we offer), Lots (inventory + expirations), Entry (quick-entry).

## Running it

From a fresh PC, or as the daily launch command, use the repo root's
one-liner (see the top-level `README.md`) — it installs prerequisites if
needed, clones/updates the repo, seeds config, then runs this:

```
.\update-and-run.ps1
```

Syncs to `origin/main`, stops any already-running copy of the app (so the
build below can't fail with a locked .exe), runs `dotnet build`, and
launches the app — which then attempts a silent auto-login if
`autologin.json` (see "Local configuration" below) is present. See the
script's own header comment for exactly what each step does.

Double-clicking the "Vaccine Assist" Desktop shortcut (created by
`install-shortcut.ps1`, normally run automatically by the repo root's
`bootstrap-fresh.ps1`) runs this exact same script.

## Local configuration

Nothing is hardcoded — the app reads two per-machine files, neither ever
committed to the repo:

**`%AppData%\VaccineAssist\settings.json`** (roaming) — created with blank
defaults on first run if missing, or seeded by the repo root's
`bootstrap-fresh.ps1` one-liner:

```json
{
  "CloudApiBaseUrl": "https://your-vaccine-assist-cloud.vercel.app",
  "SupabaseUrl": "https://xxxxxxxxxxxx.supabase.co",
  "SupabaseAnonKey": "...",
  "LastSignedInEmail": null
}
```

**`%LocalAppData%\VaccineAssist\autologin.json`** (non-roaming — kept
separate from the file above so a plaintext password never rides along in
a roaming profile) — only exists if the one-liner was run with
`-Email`/`-Password`; absent otherwise, in which case the app just shows
its normal manual login form:

```json
{
  "Email": "you@orchardsdrug.com",
  "Password": "the-shared-password"
}
```

If `SupabaseUrl`/`SupabaseAnonKey` are still blank (a checkout that never
ran the one-liner), sign-in — manual or automatic — fails with a clear
message rather than crashing.

## How auth + data flow fit together

1. At startup, if `autologin.json` is present and has both an email and
   password, the Login screen attempts one silent sign-in automatically
   (`ViewModels/LoginViewModel.cs`, `TryAutoSignInAsync`) — no prompts. If
   it fails (eg. a stale password), the screen falls back to its normal
   manual form with the error shown; it's never retried automatically, so
   a bad seeded password can't turn into a crash/retry loop.
2. Either way (manual or automatic), sign-in calls
   `Supabase.Client.Auth.SignIn(email, password)` directly against
   Supabase Auth (the `Supabase` NuGet package) — the one shared pharmacy
   login.
3. The resulting access token is sent as an `Authorization: Bearer` header
   on every call into the cloud app's own REST API
   (`Services/VaccineApiService.cs` -> `cloud/app/api/vaccines`, `/lots`,
   `/eligibility/evaluate`), which verifies it (`cloud/lib/auth.ts`) before
   returning any data.
4. Vaccine/lot/eligibility data itself always goes through the cloud app —
   this project never queries Supabase's Postgrest API directly.

## Tests

`VaccineAssist.Desktop.Tests` (xUnit) covers the auto-login logic above —
`dotnet test` from `desktop\` (or open `VaccineAssist.sln`).

## PioneerEntryAutomation

Not wired up yet — see `PioneerEntryAutomation/TODO.md`. The Entry screen's
"Generate and copy to clipboard" button is the phase-1 replacement for the
old Macro Express `vaccine-add-new.mxe` script; live PioneerRx automation
is a follow-up that needs to happen on the pharmacy's own machine.
