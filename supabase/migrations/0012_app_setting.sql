-- Vaccine Assist — generic app_setting table (V-T26, Will 2026-09-09)
--
-- MIGRATION FILE ONLY per Will's brief — not run against any database as
-- part of this change. See cloud/lib/schema-degradation.ts for how
-- GET/PUT /api/ordering/settings and GET /api/ordering/recommendation
-- keep working before this has been applied (default 25% walk-up
-- buffer, PUT degrades to { pending: true }).
--
-- A small shared key/value table for staff-editable settings that apply
-- to the whole pharmacy account rather than one user (contrast
-- acuity_credentials, which is also a single shared row but has its own
-- dedicated table/columns) — first consumer is
-- "ordering.walk_in_pct" (V-T26 item 1: the Ordering page's walk-up %
-- input, replacing the previously-hardcoded WALK_IN_BUFFER_RATE
-- constant in cloud/lib/ordering-recommendation.ts). `value` is jsonb so
-- a future setting can be a number, string, or small object without a
-- schema change — same "no FK, code-only keys" posture as
-- physician_rule.vaccine_group (0009) and ordering_target.key (0011).
create table if not exists app_setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Same posture as ordering_target/on_hand_count/inbound_email_address
-- (0011/0006/0010): RLS enabled with zero policies denies all
-- anon/authenticated access. Only the service-role key (server-only —
-- GET/PUT /api/ordering/settings) reads/writes this table; the
-- browser/desktop app never queries it directly.
alter table app_setting enable row level security;
