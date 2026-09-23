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

## Vaccine → PCP fax (V-T53)

Pioneer Rx won't email PHI, so a designated local folder is watched for a
daily immunization report (CSV/XLSX — how the file lands there, SFTP drop
or a UI-automated export, is out of scope here); the app builds one PDF
vaccine-administration record per patient/prescriber and faxes it to the
prescriber via SRFax, tracks delivery receipts, and runs automatically
once a day. Nothing PHI leaves the machine except to SRFax.

**Setup** (tray icon → "Vaccine faxes — Settings"):

1. SRFax access ID/password (saved DPAPI-protected, never in
   settings.json — see `Fax/FaxCredentialStore.cs`); "Test connection"
   calls SRFax's `Get_FaxUsage`.
2. Sender email, pharmacy name/phone/fax (the fax is used as SRFax's
   caller ID).
3. Input folder to watch, and the daily run time (default 18:30 local).
4. Column map — the report's actual header text for each field. Defaults
   are Pioneer-looking guesses; only patient first/last name, vaccine
   name, and administered date are required — a report missing one of
   those four is rejected outright with a clear message rather than
   silently skipping rows.
5. Prescriber fax number table (`%AppData%\VaccineAssist\fax\prescribers.json`,
   keyed by NPI or normalized name) — used when the report itself has no
   fax-number column. A row that resolves to no fax number at all shows
   up in the run summary as "needs fax number" instead of being sent.

**Folder layout**:

```
%AppData%\VaccineAssist\fax\        (roaming — small JSON config/state only)
  prescribers.json        editable NPI/name -> fax number table
  imported.json            row-fingerprint ledger (patient+vaccine+date+lot) —
                            prevents re-faxing the same administration twice
  ledger.json               one entry per fax: id, patient initials, fax
                            last-4, pdf path, status, receipt-check history —
                            never a patient's full name
  last-run.json             last local date the daily run completed

%LocalAppData%\VaccineAssist\fax\   (local to this PC only — never
                                      replicates to a roaming profile share
                                      on a domain-joined machine)
  outbox\<yyyyMMdd>\        PDFs freshly built this run
  sent\ / failed\           PDFs after a terminal receipt
  runs\<timestamp>.json     one summary per run (counts + per-row grid)

<input folder>\processed\<yyyy-MM-dd>\   source report files, moved here
                          after each run (never deleted)
```

**Run it manually**: tray icon → "Vaccine faxes — Run now" (works even
if the daily timer is disabled). "Open fax folder" jumps straight to the
folder above. A run shows a summary window (sent/in-process/failed/needs-
fax-number counts + a per-row grid); a Failed row has an explicit Retry
button — nothing is ever auto-retried after a vendor-reported failure, to
avoid a double-send.

Adding a second fax vendor later (Will is comparing SRFax against
Notifyre/Telnyx on price) means a new `IFaxClient` implementation plus one
line in `Fax/FaxClientFactory.cs` — nothing else in the app names
`SrFaxClient` directly.

## Tests

`VaccineAssist.Desktop.Tests` (xUnit) covers the auto-login logic above,
plus the vaccine-fax pipeline (report import/column-map validation,
patient/prescriber grouping, PDF generation, SRFax request/response
handling, the daily-run schedule, and ledger state) — `dotnet test` from
`desktop\` (or open `VaccineAssist.sln`).

## PioneerEntryAutomation

Not wired up yet — see `PioneerEntryAutomation/TODO.md`. The Entry screen's
"Generate and copy to clipboard" button is the phase-1 replacement for the
old Macro Express `vaccine-add-new.mxe` script; live PioneerRx automation
is a follow-up that needs to happen on the pharmacy's own machine.
