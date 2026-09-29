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

Pioneer Rx won't email PHI, so the pharmacist imports the WEEKLY
immunization report (CSV/XLSX) into the app directly (Will, 2026-09-28 —
staff run this about weekly, not daily; no SFTP drop, no cloud pull):
tray icon → "Vaccine faxes — Import report file…" opens a file picker,
copies the chosen file into the configured input folder, and runs
immediately. The app builds one fax-formatted letter per patient/
prescriber and faxes it to the prescriber via Notifyre (Will's pick —
SRFax also still supported, see below), and tracks delivery receipts. The
daily timer that scans the same input folder automatically still exists
(same pipeline either way) for anyone who wants that instead — see
"Automatic daily run" below — but it's OFF by default now that the normal
workflow is a manual weekly import. Nothing PHI leaves the machine except
to the fax vendor.

**Report column map** (fax-report-layout brief, 2026-09-28) — the DEFAULT
matches Pioneer Rx's real immunization-report export exactly, six
columns, nothing else:

| Field | Default report header | Required? |
|---|---|---|
| Patient full name ("Last, First Middle") | `Patient Full Name Last then First` | Yes |
| Patient date of birth | `Patient Date of Birth` | Yes |
| Vaccine name | `Dispensed Item Name` | Yes |
| Administered date | `Immunization Administered On` | Yes |
| Prescriber name | `Primary Care Prescriber` | No — see below |
| Prescriber fax | `Primary Care Prescriber Fax` | No — see below |

Lot, manufacturer, dose, route/site, VIS date, pharmacist, and prescriber
NPI have no header configured by default and are fully OPTIONAL — Pioneer's
export doesn't have them, and their absence never rejects the file or a
row (all still remappable in the column-map editor for a workstation
whose export differs). Administered date/DOB accept an Excel date serial
(the raw xlsx cell format) or a text date (`M/d/yyyy`, `MM/dd/yyyy`, or
`yyyy-MM-dd`); prescriber fax accepts `(###) ###-####`, digits-only, or
dashed — all normalize to digits for sending while the letter still shows
a clean `(###) ###-####` display form regardless of how it was typed.

**Rows with no usable prescriber fax are skipped, not errors**: a row
whose prescriber name is blank, or whose fax number is blank/invalid (and
isn't in the prescriber-fax table either), is silently left out of this
run — no PDF, no fax queued, no "failed" — and counted in the run summary
as "Skipped (no prescriber fax)" in a neutral color, never nagged as an
error. It's never fingerprinted, so a later report (or the same one,
re-imported after adding the prescriber's fax number in Settings) can
still pick it up.

**The fax letter** (`Fax/VaccineRecordPdfBuilder.cs`) matches the format
Orchards Drug already sends today: a "Fax" title + "Vaccine Administration
Notification" subtitle, the pharmacy's identity block (name/address/
phone/fax — see the new Address/City-State-Zip settings below), a "To:"
block naming the prescriber and the fax number this letter is actually
being sent to, the standard "Dear provider, ..." notice paragraph
verbatim, a 4-column table (Patient Name / Birth Date / Vaccination /
Date Administered — one row per vaccine for that patient/prescriber pair
in the import), and "Sincerely," plus a configurable signature name. Clean
sans-serif font, consistent margins, a shaded/thin-ruled table, and a
"Page x of y" footer only when the letter runs past one page.

**Setup** (tray icon → "Vaccine faxes — Settings"):

1. Pick a **Provider** — **Notifyre** (default for a fresh install) or
   **SRFax**:
   - **Notifyre**: paste the API token from the Notifyre dashboard →
     Settings → Developer → New. Saved DPAPI-protected, never in
     settings.json (see `Fax/FaxCredentialStore.cs`). The token box is
     always BLANK when you open Settings — even when a key IS already
     saved, the real token is never shown again — with a read-only line
     underneath: "Notifyre key saved (ends …1234, saved 2026-09-28
     19:20)" or "No key saved." Leave the box blank and click Save to
     keep the existing key untouched; paste a new value to replace it.
     "Forget key" (with a confirm prompt) clears the stored token
     entirely. "Test connection" calls Notifyre's `GET /fax/numbers` (a
     0-number account is normal for outbound-only sending and still
     shows "Connected") and says which key it used — "Connected using
     the saved key" vs. "Connected using the key in the box (not saved
     yet — press Save)" — so it's never ambiguous whether a real send
     will use what you just typed or what was already on disk. Saving
     (or a successful Test connection that discovers a different auth
     header form) immediately swaps the live sending client in the
     running app — no restart needed for a new/changed key to take
     effect on the next run.
   - **SRFax**: access ID/password (same DPAPI storage). "Test
     connection" calls SRFax's `Get_FaxUsage`.
2. Sender email, pharmacy identity — name, **address line 1**, **city/
   state/zip**, phone, fax (SRFax uses the fax number as its caller ID;
   Notifyre doesn't use pharmacy fax/caller-id fields) — all printed on
   the fax letter's pharmacy block, plus a **signature name** (defaults to
   "Will Anderson, Pharm.D.", editable) printed under "Sincerely,".
3. Input folder (where "Import report file…" copies the picked report to,
   and what the optional daily timer scans), and the daily run time
   (default 18:30 local, only used if "Automatic daily run" is on).
4. Column map — the report's actual header text for each field (defaults
   above). Patient full name, DOB, vaccine name, and administered date are
   required — a report missing any of those four is rejected outright
   with a clear message rather than silently skipping rows. Prescriber
   name/fax are not required at the file level (see "skipped" above).
5. Prescriber fax number table (`%AppData%\VaccineAssist\fax\prescribers.json`,
   keyed by NPI or normalized name) — used as a FALLBACK when the report's
   own fax column is empty for that row.

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

**Run it**: tray icon → "Vaccine faxes — Import report file…" (the normal
path — picks a CSV/XLSX, copies it into the input folder, runs
immediately) or "— Run now" (re-scans whatever's already in the input
folder, works even if "Automatic daily run" is off). "Open fax folder"
jumps straight to the folder above. A run shows a summary window (Sent /
Queued-In process / Failed / Skipped (no prescriber fax) counts + a
per-row grid showing patient initials, prescriber, fax last-4, and
status); a Failed row has an explicit Retry button — nothing is ever
auto-retried after a vendor-reported failure, to avoid a double-send.

Adding another fax vendor later means a new `IFaxClient` implementation
plus one line in `Fax/FaxClientFactory.cs` — nothing else in the app
names `SrFaxClient` or `NotifyreFaxClient` directly.

## Tests

`VaccineAssist.Desktop.Tests` (xUnit) covers the auto-login logic above,
plus the vaccine-fax pipeline (report import/column-map validation,
patient/prescriber grouping, PDF generation, SRFax and Notifyre
request/response handling, the daily-run schedule, and ledger state) —
`dotnet test` from `desktop\` (or open `VaccineAssist.sln`).

## PioneerEntryAutomation

Not wired up yet — see `PioneerEntryAutomation/TODO.md`. The Entry screen's
"Generate and copy to clipboard" button is the phase-1 replacement for the
old Macro Express `vaccine-add-new.mxe` script; live PioneerRx automation
is a follow-up that needs to happen on the pharmacy's own machine.
