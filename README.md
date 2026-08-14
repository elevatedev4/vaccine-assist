# Vaccine Assist

Pharmacy vaccine workflow app for Orchards Drug: offering/lot management, eligibility rules, PioneerRx entry automation, Acuity-fed scheduling dashboard, order suggestions.

- `cloud/` — Next.js 15 app (Vercel): REST API for the desktop app, Acuity polling stub (aggregate counts only — no PHI), SES inbound webhook stub, future reporting UI. See `cloud/README` inline docs and `cloud/.env.example`.
- `desktop/` — WPF .NET 8 Windows app: Login, Vaccines, Lots, Entry screens. See `desktop/README.md` for local setup/config and `desktop/update-and-run.ps1` to build+launch.
- `supabase/migrations/` — schema (vaccine, eligibility_rule, lot, appointment_count; RLS enabled, single shared login).
- `supabase/seed/` — generated seed data: `vaccines.sql` (from the pharmacy's formulary export) and `eligibility_rules.sql` (decoded from the old Macro Express age/eligibility gates). See `cloud/scripts/` for the generators.

No PHI is stored anywhere in this system. Vaccination records live in PioneerRx.

## Windows pharmacy workstation: one-liner setup + launch

One PowerShell line does everything — fresh install (nothing on the PC
yet) or a daily "just open it" launch (already installed), signed in
either way:

```powershell
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/elevatedev4/vaccine-assist/main/bootstrap-fresh.ps1))) -Email you@orchardsdrug.com -Password "the-shared-password" -ServerUrl https://your-vaccine-assist-cloud.vercel.app
```

Paste the exact same line every time — no separate "first time" vs.
"every day after" command to remember. See `bootstrap-fresh.ps1`'s own
header comment for exactly what each step does (installs Git/.NET 8 SDK
via `winget` if missing, clones the repo, creates the "Vaccine Assist"
Desktop shortcut, seeds the shared login, then builds and launches).

After the first run, double-clicking the "Vaccine Assist" Desktop
shortcut does the same sync+build+launch as pasting the one-liner again.

## Status

Phase 1 scaffold (2026-08-13): schema, seed data, cloud API skeleton, and
desktop app skeleton exist end-to-end, but no Supabase project has been
provisioned yet — everything runs from `.env.example`/`settings.json`
placeholders. Live PioneerRx entry automation is not wired up (see
`desktop/VaccineAssist.Desktop/PioneerEntryAutomation/TODO.md`).
