-- Vaccine Assist — "Ordered today" packages tracking (V-ordering-ordered-
-- today, Will 2026-09-25 verbatim): "Add a field to the table/recommended
-- order where I can enter the # packages I have ordered for today, they
-- way I can keep track of what I've ordered and know if I need to order
-- more. If something has met the total amount we were supposed to
-- order, you can mark it as 'already ordered full amount' and separate
-- it to the bottom of the recommended order."
--
-- MIGRATION FILE ONLY per standing convention — not run against any
-- database as part of this change; the coder writes the migration, the
-- manager/Will applies it from his own terminal
-- (scripts/apply-migration.mjs). Application code already tolerates this
-- table not existing yet — GET /api/ordering/recommendation and PUT
-- /api/ordering/ordered-today both degrade to "every row's ordered-today
-- is 0" / a pending response (never a 500) via lib/schema-degradation.ts's
-- isMissingTableError, same posture as ordering_target (0011) and
-- app_setting (0012) before their own migrations ran.
--
-- One row per PRODUCT ROW KEY (`key` — the SAME identifier every other
-- ordering lib/route uses: a digits-only NDC, or "vaccine:<id>" for a
-- no-NDC product — see app/api/ordering/recommendation/route.ts's
-- RESPONSE CONTRACT) per America/Chicago CALENDAR DAY
-- (lib/chicago-date.ts's todayInChicago) — NOT a running total across
-- days: a new Chicago calendar day has no row yet, so every product
-- implicitly starts back at 0 packages ordered with no explicit reset
-- step. `packages_ordered` is a plain integer count of PACKAGES (not
-- doses) — the same unit the "To order" table's Order (pkg) column
-- already shows (lib/vaccine-product-catalog.ts's computeOrderPackages),
-- so a package count entered here compares directly against it
-- (lib/ordering-ordered-today.ts's remainingPackages/isFullyOrdered).
--
-- unique(key, order_date): at most one row per product per day — PUT
-- /api/ordering/ordered-today upserts on this pair, same
-- one-row-per-identity posture as ordering_target's unique(scope, key).
-- No FK to `vaccine`/`ordering_target`: `key` is a code-derived string
-- (an NDC or "vaccine:<id>"), not a table row, same "no FK, code-only
-- keys" rationale ordering_target.key (0011) and app_setting.key (0012)
-- already document.
create table if not exists ordering_ordered_today (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  order_date date not null,
  packages_ordered integer not null check (packages_ordered >= 0),
  updated_at timestamptz not null default now(),
  unique (key, order_date)
);

-- Same posture as ordering_target/app_setting (0011/0012): RLS enabled
-- with zero policies denies all anon/authenticated access. Only the
-- service-role key (server-only — GET /api/ordering/recommendation, PUT
-- /api/ordering/ordered-today) reads/writes this table; the
-- browser/desktop app never queries it directly.
alter table ordering_ordered_today enable row level security;

-- Supports GET /api/ordering/recommendation's per-day lookup (WHERE
-- order_date = today), same rationale as ordering_target's implicit
-- primary-key-order scan needing no extra index (that table has no
-- per-day dimension) — this one does, so an explicit index keeps that
-- daily lookup from scanning every historical row once this table has
-- accumulated many days' worth.
create index if not exists ordering_ordered_today_order_date_idx on ordering_ordered_today (order_date);
