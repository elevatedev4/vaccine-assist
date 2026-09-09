-- Vaccine Assist — on-hand NDC/stock-size columns + ordering targets
-- (V-ordering-targets, Will 2026-09-08)
--
-- MIGRATION FILE ONLY per Will's brief — not run against any database as
-- part of this change.
--
-- Backs three asks from Will (msgs 904/908/909):
--   A. Let staff set their own target on-hand balance, by NDC or by
--      vaccine GROUP (e.g. "Flu shots"), instead of only ever seeing the
--      auto-recommended target.
--   B. Collapse a multi-dose series (Gardasil x3, etc.) into ONE
--      ordering-recommendation row per product/NDC, not one per catalog
--      vaccine row.
--   C. A manual on-hand upload button (already shipped, see
--      supabase/migrations/0006/0010) that also accepts Pioneer's real
--      xlsx/csv "current BOH" export — this migration adds the columns
--      that export's extra data (NDC, per-dose stock size) needs to
--      persist alongside the existing quantity.
--
-- Same "add column if not exists, old rows just get the default"
-- posture as 0008/0009/0010 — cloud/lib/schema-degradation.ts and
-- cloud/lib/on-hand/insert.ts let every route touching these keep
-- working before this migration has run, degrading gracefully rather
-- than crashing (see those files' doc comments).

-- on_hand_count.ndc / stock_size — the two extra columns a Pioneer BOH
-- export row carries beyond the original "VaccineName, Quantity" shape
-- (see cloud/lib/on-hand/pioneer-boh.ts). `ndc` is stored DIGITS ONLY
-- (cloud/lib/ndc.ts's normalizeNdc) so it compares directly against
-- vaccine.ndc once that's normalized the same way — this table's ndc is
-- deliberately NOT a foreign key to vaccine.ndc: an unmatched row (no
-- catalog vaccine recognized this NDC) still needs to store the NDC it
-- saw, for manual review, exactly like vaccine_name_raw already does for
-- an unmatched name. `stock_size` is the per-dose size Pioneer reports
-- (e.g. 0.5 for a 0.5 mL dose) — needed alongside quantity (which
-- already holds the COMPUTED dose count, not the raw BOH) so a
-- historical row can still be audited against the source numbers.
alter table on_hand_count
  add column if not exists ndc text;

alter table on_hand_count
  add column if not exists stock_size numeric;

-- Supports the ordering recommendation route's per-NDC "latest on-hand"
-- lookup (collapsing a multi-dose series to one row keyed by NDC — see
-- cloud/app/api/ordering/recommendation/route.ts), same pattern as
-- on_hand_count_vaccine_received_idx in 0006.
create index if not exists on_hand_count_ndc_idx on on_hand_count (ndc);

-- ordering_target — staff-set target on-hand balance, by NDC (a single
-- product) or by GROUP (cloud/lib/vaccine-group-catalog.ts's display
-- groups, e.g. "Flu"). `key` is the digits-only NDC for scope='ndc', or
-- the group's exact display-name string for scope='group' — no FK to
-- either `vaccine` or a groups table (groups are code-only, same
-- rationale physician_rule.vaccine_group in 0009 already documents: the
-- catalog is a static TypeScript lookup, not a DB table).
--
-- unique(scope, key): at most one target per NDC, and at most one target
-- per group — cloud/lib/ordering-targets.ts's effectiveTarget/apportioning
-- reads/writes exactly this shape via PUT /api/ordering/targets (null
-- target_on_hand deletes the row rather than storing a null, so this
-- table only ever holds ACTIVE overrides).
create table if not exists ordering_target (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('ndc', 'group')),
  key text not null,
  target_on_hand integer not null check (target_on_hand >= 0),
  updated_at timestamptz not null default now(),
  unique (scope, key)
);

-- Same posture as on_hand_count/inbound_email_address (0006/0010): RLS
-- enabled with zero policies denies all anon/authenticated access. Only
-- the service-role key (server-only — GET/PUT /api/ordering/targets)
-- reads/writes this table; the browser/desktop app never queries it
-- directly.
alter table ordering_target enable row level security;
