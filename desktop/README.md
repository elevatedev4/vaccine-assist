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

## Vaccine → PCP fax (V-T53, simplified V-T65 2026-09-29)

Pioneer Rx won't email PHI, so the pharmacist imports the immunization
report (CSV/XLSX) into the app directly, no SFTP drop, no cloud pull, no
scheduled/automatic run: tray icon → **"Vaccine faxes"** opens ONE file
picker, and picking a report immediately imports it and sends the faxes —
no intermediate dialogs. The app builds one fax-formatted letter per
patient/prescriber and faxes it to the prescriber via Notifyre (Will's
pick — SRFax also still supported, see below), tracks delivery receipts,
then shows the summary window. Nothing PHI leaves the machine except to
the fax vendor.

Will, verbatim (V-T65, 2026-09-29): "Add the save button near the
Notifyre key. Everything else should save as it is typed ... To fax using
a report, I want to just import the file myself ... One file selector,
then send faxes. Then you can display the summary of the processing and
actions and results." This removed the prescriber-fax-number table, the
input-folder setting, and the daily/scheduled run entirely — the report's
own Primary Care Prescriber Fax column is now the ONLY fax-number source.

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
whose prescriber name is blank, or whose fax number is blank/invalid, is
silently left out of this run — no PDF, no fax queued, no "failed" — and
counted in the run summary as "Skipped (no prescriber fax)" in a neutral
color, never nagged as an error. It's never fingerprinted, so a later
report (or the same one, re-imported after the source system's own
prescriber-fax data is fixed) can still pick it up.

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

Every field EXCEPT the provider credentials auto-saves as you type/select
it (~300ms debounce on a text field, immediate on the Provider dropdown) —
a small "Saved" hint appears briefly under the title after each auto-save.
There is no bottom Save button anymore.

1. Pick a **Provider** — **Notifyre** (default for a fresh install) or
   **SRFax**. The credentials group keeps its OWN explicit **Save**
   button right below the key box (PasswordBox contents can't auto-save
   the way a plain text field can), alongside Test connection and (Notifyre
   only) Forget key:
   - **Notifyre**: paste the API token from the Notifyre dashboard →
     Settings → Developer → New, then click **Save**. Saved
     DPAPI-protected, never in settings.json (see
     `Fax/FaxCredentialStore.cs`). The token box is always BLANK when you
     open Settings — even when a key IS already saved, the real token is
     never shown again — with a read-only line underneath: "Notifyre key
     saved (ends …1234, saved 2026-09-28 19:20)" or "No key saved." Leave
     the box blank and click Save to keep the existing key untouched;
     paste a new value to replace it. "Forget key" (with a confirm
     prompt) clears the stored token entirely. "Test connection" calls
     Notifyre's `GET /fax/numbers` (a 0-number account is normal for
     outbound-only sending and still shows "Connected") and says which
     key it used — "Connected using the saved key" vs. "Connected using
     the key in the box (not saved yet — press Save)" — so it's never
     ambiguous whether a real send will use what you just typed or what
     was already on disk. Saving (or a successful Test connection that
     discovers a different auth header form) immediately swaps the live
     sending client in the running app — no restart needed for a
     new/changed key to take effect on the next run.
   - **SRFax**: access ID/password (same DPAPI storage, same Save
     button). "Test connection" calls SRFax's `Get_FaxUsage`.
2. Sender email, pharmacy identity — name, **address line 1**, **city/
   state/zip**, phone, fax (SRFax uses the fax number as its caller ID;
   Notifyre doesn't use pharmacy fax/caller-id fields) — all printed on
   the fax letter's pharmacy block, plus a **signature name** (defaults to
   "Will Anderson, Pharm.D.", editable) printed under "Sincerely," — all
   auto-save as typed.
3. Column map — the report's actual header text for each field (defaults
   above), auto-saves on edit. Patient full name, DOB, vaccine name, and
   administered date are required — a report missing any of those four is
   rejected outright with a clear message rather than silently skipping
   rows. Prescriber name/fax are not required at the file level (see
   "skipped" above).

No input folder, no daily run time, and no prescriber fax number table
anymore — the report's own Primary Care Prescriber Fax column is the ONLY
fax-number source (V-T65).

**Folder layout**:

```
%AppData%\VaccineAssist\fax\        (roaming — small JSON config/state only)
  imported.json            row-fingerprint ledger (patient+vaccine+date+lot) —
                            prevents re-faxing the same administration twice
  ledger.json               one entry per fax: id, patient initials, fax
                            number, last-4, pdf path, status, receipt-check
                            history — never a patient's full name

%LocalAppData%\VaccineAssist\fax\   (local to this PC only — never
                                      replicates to a roaming profile share
                                      on a domain-joined machine)
  outbox\<yyyyMMdd>\        PDFs freshly built this run
  sent\ / failed\           PDFs after a terminal receipt
  runs\<timestamp>.json     one summary per run (counts + per-row grid)
```

The picked report file itself is never moved, renamed, or deleted — it
stays exactly where you selected it from.

**Run it**: tray icon → **"Vaccine faxes"** — ONE file picker (CSV/XLSX);
picking a report immediately imports it and sends the faxes, no
intermediate dialogs. "Open fax folder" jumps straight to the folder
above. A run shows a summary window (Sent / Queued-In process / Failed /
Skipped (no prescriber fax) counts + a per-row grid showing patient
initials, prescriber, fax last-4, and status); a Failed row has an
explicit Retry button — nothing is ever auto-retried after a
vendor-reported failure, to avoid a double-send.

Adding another fax vendor later means a new `IFaxClient` implementation
plus one line in `Fax/FaxClientFactory.cs` — nothing else in the app
names `SrFaxClient` or `NotifyreFaxClient` directly.

## Tests

`VaccineAssist.Desktop.Tests` (xUnit) covers the auto-login logic above,
plus the vaccine-fax pipeline (single-file report import/column-map
validation, patient grouping, PDF generation, SRFax and Notifyre
request/response handling, the auto-save debounce policy, and ledger
state) — `dotnet test` from `desktop\` (or open `VaccineAssist.sln`).

## PioneerEntryAutomation

Not wired up yet — see `PioneerEntryAutomation/TODO.md`. The Entry screen's
"Generate and copy to clipboard" button is the phase-1 replacement for the
old Macro Express `vaccine-add-new.mxe` script; live PioneerRx automation
is a follow-up that needs to happen on the pharmacy's own machine.
