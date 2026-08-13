# Vaccine Assist — desktop

WPF (.NET 8) app for the pharmacy workstation. Screens: Login, Vaccines (what
we offer), Lots (inventory + expirations), Entry (quick-entry).

## Running it

```
.\update-and-run.ps1
```

Syncs to `origin/main`, runs `dotnet build`, and launches the app. See the
script's own header comment for exactly what each step does.

## Local configuration

Nothing is hardcoded — the app reads `%AppData%\VaccineAssist\settings.json`
at startup (created with blank defaults on first run if missing):

```json
{
  "CloudApiBaseUrl": "https://your-vaccine-assist-cloud.vercel.app",
  "SupabaseUrl": "https://xxxxxxxxxxxx.supabase.co",
  "SupabaseAnonKey": "...",
  "LastSignedInEmail": null
}
```

Phase 1: no Supabase project exists yet, so a fresh checkout with blank
settings will fail to sign in with a clear message rather than crashing —
this is expected until `SupabaseUrl`/`SupabaseAnonKey` point at a real
project and `CloudApiBaseUrl` points at a deployed cloud app.

## How auth + data flow fit together

1. Login screen calls `Supabase.Client.Auth.SignIn(email, password)`
   directly against Supabase Auth (the `Supabase` NuGet package) — the one
   shared pharmacy login.
2. The resulting access token is sent as an `Authorization: Bearer` header
   on every call into the cloud app's own REST API
   (`Services/VaccineApiService.cs` -> `cloud/app/api/vaccines`, `/lots`,
   `/eligibility/evaluate`), which verifies it (`cloud/lib/auth.ts`) before
   returning any data.
3. Vaccine/lot/eligibility data itself always goes through the cloud app —
   this project never queries Supabase's Postgrest API directly.

## PioneerEntryAutomation

Not wired up yet — see `PioneerEntryAutomation/TODO.md`. The Entry screen's
"Generate and copy to clipboard" button is the phase-1 replacement for the
old Macro Express `vaccine-add-new.mxe` script; live PioneerRx automation
is a follow-up that needs to happen on the pharmacy's own machine.
