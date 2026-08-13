-- Vaccine Assist — phase 1 schema
--
-- Single-tenant app with ONE shared pharmacy login (Supabase Auth,
-- email/password) used by both the desktop app and the cloud app. RLS is
-- enabled on every table with a single "authenticated can do everything"
-- policy per table/action — this is not multi-tenant row isolation, it's
-- "logged-in staff can use the app, anonymous cannot."

-- ---------------------------------------------------------------------
-- vaccine — the formulary: what we offer, cash pricing, macro short code
-- ---------------------------------------------------------------------
create table if not exists vaccine (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ndc text,
  dose text,
  short_code text not null,
  cash_price_cents integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists vaccine_short_code_key on vaccine (short_code);
create index if not exists vaccine_ndc_idx on vaccine (ndc);
create index if not exists vaccine_active_idx on vaccine (active);

-- ---------------------------------------------------------------------
-- eligibility_rule — replaces the 24 age/eligibility CASE blocks in the
-- old vaccine-add-new.mxe Macro Express script. A vaccine may have more
-- than one rule (e.g. a base age floor plus a separate pregnancy
-- warning); `priority` controls evaluation order when messages need to
-- accumulate deterministically. See cloud/lib/eligibility.ts.
-- ---------------------------------------------------------------------
create table if not exists eligibility_rule (
  id uuid primary key default gen_random_uuid(),
  vaccine_id uuid not null references vaccine (id) on delete cascade,
  min_age integer,
  max_age integer,
  condition_note text,
  pregnancy_warning boolean not null default false,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eligibility_rule_age_range_chk
    check (min_age is null or max_age is null or min_age <= max_age)
);

create index if not exists eligibility_rule_vaccine_id_idx on eligibility_rule (vaccine_id);

-- ---------------------------------------------------------------------
-- lot — inventory with expirations (staff-maintained "Current lots"
-- sheet, replaced by the desktop app's Lots screen)
-- ---------------------------------------------------------------------
create type lot_status as enum ('active', 'depleted');

create table if not exists lot (
  id uuid primary key default gen_random_uuid(),
  vaccine_id uuid not null references vaccine (id) on delete cascade,
  lot_number text not null,
  expiration date not null,
  status lot_status not null default 'active',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lot_vaccine_id_idx on lot (vaccine_id);
create index if not exists lot_status_idx on lot (status);
create index if not exists lot_expiration_idx on lot (expiration);

-- ---------------------------------------------------------------------
-- appointment_count — aggregate-only Acuity poll output (no PHI: counts
-- per vaccine type per day, matching the current Google Sheets
-- dashboard). See app/api/acuity/poll/route.ts (stubbed in phase 1).
-- ---------------------------------------------------------------------
create table if not exists appointment_count (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  vaccine_type text not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_count_unique unique (date, vaccine_type)
);

create index if not exists appointment_count_date_idx on appointment_count (date);

-- ---------------------------------------------------------------------
-- updated_at maintenance trigger, shared by all four tables
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger vaccine_set_updated_at before update on vaccine
  for each row execute function set_updated_at();

create trigger eligibility_rule_set_updated_at before update on eligibility_rule
  for each row execute function set_updated_at();

create trigger lot_set_updated_at before update on lot
  for each row execute function set_updated_at();

create trigger appointment_count_set_updated_at before update on appointment_count
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- RLS — single shared login, so policies simply require `authenticated`.
-- No anonymous access to any table.
-- ---------------------------------------------------------------------
alter table vaccine enable row level security;
alter table eligibility_rule enable row level security;
alter table lot enable row level security;
alter table appointment_count enable row level security;

create policy vaccine_authenticated_all on vaccine
  for all to authenticated using (true) with check (true);

create policy eligibility_rule_authenticated_all on eligibility_rule
  for all to authenticated using (true) with check (true);

create policy lot_authenticated_all on lot
  for all to authenticated using (true) with check (true);

create policy appointment_count_authenticated_all on appointment_count
  for all to authenticated using (true) with check (true);
