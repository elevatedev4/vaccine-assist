-- Vaccine Assist — protocol physicians + physician assignment rules
--
-- Replaces "type the prescriber's name from memory" for vaccine entry.
-- Will (2026-09-05, from the live UIA-dump collection session): different
-- vaccines/age ranges are administered under different protocol
-- physicians — e.g. the federal PREP act lets the pharmacist himself
-- cover flu/COVID (age 3+) and "childhood" vaccines (age 3-17), while
-- Kansas's statewide pharmacy protocol covers everything else under a
-- named protocol physician, gated by its own age floor. Staff enter each
-- physician's Pioneer "alternate ID" here once (set on the physician's
-- own Pioneer profile: Prescriber profile > Alternate ID > an ID of the
-- pharmacy's choosing, no spaces) plus which vaccine/age combinations
-- they cover; PioneerEntryAutomation's prescriber-entry step
-- (Sequencing/Steps/SelectPrescriberStep.cs) types the RESOLVED
-- physician's alternate ID into PioneerRx's own physician quick-search
-- field instead of a human typing a name from memory.

create table if not exists physician (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  alternate_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists physician_alternate_id_key on physician (alternate_id);

-- ---------------------------------------------------------------------
-- physician_rule — which physician covers a given vaccine + age range.
--
-- vaccine_id NULL means "any vaccine" — the wildcard/"everything else"
-- fallback rule from Will's own example (the protocol physician who
-- covers everything past a certain age that the pharmacist's own
-- PREP-act authority doesn't already cover). A non-null vaccine_id is a
-- specific-vaccine override and always outranks a wildcard rule for the
-- same age, regardless of `priority` — see
-- cloud/lib/physician-resolution.ts resolvePhysicianRule for the exact
-- specificity-then-priority tie-break. `priority` only breaks ties
-- WITHIN the same specificity tier (lower number wins first), same
-- convention as eligibility_rule.priority in 0001_init.sql.
--
-- No vaccine "group"/category concept exists in this schema (see
-- vaccine table, 0001_init.sql) — modeling "childhood vaccines" or
-- "everything else" as specific-vaccine rules (one row per vaccine) plus
-- one wildcard row is a deliberately simpler design than adding a new
-- vaccine-group taxonomy; flagged as a judgment call in the change that
-- introduced this table.
-- ---------------------------------------------------------------------
create table if not exists physician_rule (
  id uuid primary key default gen_random_uuid(),
  physician_id uuid not null references physician (id) on delete cascade,
  vaccine_id uuid references vaccine (id) on delete cascade,
  min_age integer,
  max_age integer,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint physician_rule_age_range_chk
    check (min_age is null or max_age is null or min_age <= max_age)
);

create index if not exists physician_rule_vaccine_id_idx on physician_rule (vaccine_id);
create index if not exists physician_rule_physician_id_idx on physician_rule (physician_id);

-- set_updated_at() already created in 0001_init.sql.
create trigger physician_set_updated_at before update on physician
  for each row execute function set_updated_at();

create trigger physician_rule_set_updated_at before update on physician_rule
  for each row execute function set_updated_at();

-- Same single-shared-login RLS posture as every other staff-facing table
-- (vaccine/eligibility_rule/lot in 0001_init.sql): authenticated can do
-- everything, anonymous can do nothing.
alter table physician enable row level security;
alter table physician_rule enable row level security;

create policy physician_authenticated_all on physician
  for all to authenticated using (true) with check (true);

create policy physician_rule_authenticated_all on physician_rule
  for all to authenticated using (true) with check (true);
