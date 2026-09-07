-- Vaccine Assist — lots beyond-use date + vaccine Pioneer defaults +
-- physician rule vaccine groups (V-cloud-tabs, Will 2026-09-05/07)
--
-- Four additive columns, same "add column if not exists, old rows just
-- get the default" posture as 0008_acuity_poll_cache_hourly_counts.sql —
-- nothing here is backfilled or required, and cloud/lib/schema-degradation.ts
-- lets every route touching these keep working before this migration has
-- been run against a given environment (dev/staging catch up on their own
-- schedule), degrading to a "pending migration" note client-side rather
-- than crashing.
--
-- MIGRATION FILE ONLY per Will's brief — not run against any database as
-- part of this change.

-- lot.beyond_use_date — optional, staff-entered on the rebuilt /lots
-- table alongside expiration (see app/lots/page.tsx). Nullable: most
-- vaccines are single-dose vials with no separate BUD tracking need: only
-- the ones staff actually reconstitute/multi-dose-puncture get one set.
alter table lot
  add column if not exists beyond_use_date date;

-- vaccine.quantity / vaccine.directions — Pioneer prescription-entry
-- defaults (dose quantity + sig/directions text) staff maintain on the
-- /vaccines page (Active vaccines). Plumbing only per Will's brief — no
-- values are seeded here; Will supplies the real per-vaccine data later.
-- Free-text (`text`, not a numeric/enum column) because Pioneer's own
-- quantity/directions fields on a prescription accept arbitrary strings
-- (e.g. "0.5 mL", "1 dose IM x1") rather than a single unit type.
alter table vaccine
  add column if not exists quantity text;

alter table vaccine
  add column if not exists directions text;

-- physician_rule.vaccine_group — lets a rule target an entire vaccine
-- GROUP (flu, COVID, Tdap, pneumonia, ...) from
-- cloud/lib/vaccine-group-catalog.ts instead of one specific vaccine_id,
-- per Will's brief for the /physicians rule dropdown ("show vaccine
-- types, then specific vaccines underneath; a TYPE can itself be
-- selected as the rule target, mapped to its products on the backend").
-- Nullable, and mutually exclusive with vaccine_id in practice (enforced
-- app-side in cloud/lib/physician-resolution.ts / the physician-rules API
-- routes, not by a DB constraint — same "no DB constraint for an
-- app-level invariant" posture the vaccine_id-nullable wildcard rule
-- already uses): a specific-vaccine rule (vaccine_id set) always outranks
-- a group rule, which always outranks the wildcard
-- (vaccine_id and vaccine_group both null) — see
-- resolvePhysicianRule's specificity tiers.
--
-- Stores the catalog's group DISPLAY NAME (e.g. "Flu", "COVID") as plain
-- text rather than a foreign key — the catalog is a static TypeScript
-- lookup table (deliberately duplicated from the desktop app, see that
-- file's own doc comment), not a DB table, so there is no id to reference.
alter table physician_rule
  add column if not exists vaccine_group text;

create index if not exists physician_rule_vaccine_group_idx on physician_rule (vaccine_group);
