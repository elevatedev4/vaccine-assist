# Vaccine Assist

Pharmacy vaccine workflow app for Orchards Drug: offering/lot management, eligibility rules, PioneerRx entry automation, Acuity-fed scheduling dashboard, order suggestions.

- `cloud/` — Next.js app (Vercel): API, Acuity polling (aggregate counts only — no PHI), SES inbound report ingestion, future reporting UI
- `desktop/` — WPF .NET 8 Windows app: login, inventory, entry automation

No PHI is stored anywhere in this system. Vaccination records live in PioneerRx.
