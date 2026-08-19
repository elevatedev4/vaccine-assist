-- Vaccine Assist — Lots table seed (V-Q, Will 2026-08-19)
--
-- Real (non-PHI) lot/expiration data from Orchards Drug's current
-- "Current lots" sheet — synthetic-fine per Will's explicit go-ahead,
-- this is not PHI (no patient data, just inventory: lot numbers and
-- expiration dates for the pharmacy's vaccine stock).
--
-- Two things happen here, both idempotent (safe to re-run):
--
--   1. Any of the 29 vaccine names below that do NOT already exist in
--      `vaccine` (matched against supabase/seed/vaccines.sql's ~31-row
--      catalog — see the name-matching table in this migration's PR/task
--      notes) get inserted with reasonable defaults: active = true,
--      ndc/short_code left minimal (a slugified short_code is required —
--      the column is NOT NULL — but no real NDC is guessed), dose/
--      cash_price_cents left null. This migration adds exactly 6 new
--      catalog rows: Pfizer 5-11, Pfizer 3-4, Fluarix PFS, Fluzone PFS,
--      Flulaval, Pneumovax 23.
--
--   2. For every one of the 29 rows that has a lot number, a `lot` row is
--      inserted (status = 'active') against the matching vaccine. Rows
--      with a blank lot/expiration (Pfizer 5-11, Flucelvax MDV, Fluarix
--      PFS, Fluzone PFS, Fluzone HD, Flulaval, Pneumovax 23) intentionally
--      get NO lot row — Will: "Keep rows with blank lot/exp too (they're
--      the vaccine catalog)" — the vaccine catalog entry from step 1/the
--      existing seed is enough for those.
--
-- `vaccine.name` has no unique constraint (see supabase seed data: several
-- names repeat across dose-specific short_codes, e.g. "Gardasil" has 3
-- rows for doses 1/2/3). This migration never assumes one exists —
-- matching and idempotency below are both done with explicit
-- `where not exists (...)` guards, not `on conflict`.
--
-- DOSE-AMBIGUOUS NAME NOTE (flagged for Will/manager review): a few seed
-- names below match an EXISTING vaccine name that has multiple rows in
-- the catalog, one per dose in a series (Shingrix 1/2, Gardasil 1/2/3,
-- MMR-II 1/2, Priorix 1/2, Vaqta adult 1/2, Engerix 20 1/2/3). The `lot`
-- table's `vaccine_id` is a single FK, so a lot row can only ever point
-- at ONE of those dose rows. This migration deterministically picks the
-- lowest `short_code` for each name (e.g. "shingrix1" over "shingrix2",
-- "gardasil1" over "gardasil2"/"gardasil3") as a best-effort default —
-- there was no way to know from the lot sheet alone which dose in the
-- series this particular lot's stock is for. If that's wrong for any of
-- these, it's a one-row `update lot set vaccine_id = ...` fix, not a
-- schema problem.

-- ---------------------------------------------------------------------
-- Step 1: new vaccine catalog rows for names with no existing match.
-- ---------------------------------------------------------------------
insert into vaccine (name, short_code, active)
select v.name, v.short_code, true
from (
  values
    ('Pfizer 5-11', 'pfizer511'),
    ('Pfizer 3-4', 'pfizer34'),
    ('Fluarix PFS', 'fluarixpfs'),
    ('Fluzone PFS', 'fluzonepfs'),
    ('Flulaval', 'flulaval'),
    ('Pneumovax 23', 'pneumovax23')
) as v(name, short_code)
where not exists (select 1 from vaccine where vaccine.name = v.name);

-- ---------------------------------------------------------------------
-- Step 2: lot rows. `lookup_name` is the vaccine.name each seed row
-- resolves to — either the same name just inserted in step 1, or a
-- clearly-equivalent existing catalog name (e.g. "Pfizer 12+" ->
-- "Comirnaty 2025-26 12+", the Pfizer COVID vaccine's brand name;
-- "Moderna 12+ NEXSPIKE" -> "mNEXSPIKE"; "FluMist" -> "FluMist
-- (age 2-49)"; "MMR" -> "MMR-II"). Rows with a blank lot_number are
-- listed here too (commented as such) purely for the record — they
-- intentionally produce no lot insert.
-- ---------------------------------------------------------------------
do $$
declare
  seed record;
  vid uuid;
begin
  for seed in
    select * from (
      values
        -- (seed name,                   lookup name,                     lot_number,     expiration)
        ('Moderna 3-11 Spikevax 25-26', 'Spikevax',                       '3053855',      '2026-07-08'::date),
        ('Moderna 12+ NEXSPIKE',        'mNEXSPIKE',                      '3053756',      '2026-08-22'::date),
        ('Pfizer 5-11',                 'Pfizer 5-11',                    null,           null),
        ('Pfizer 12+',                  'Comirnaty 2025-26 12+',          'NR6057',       '2027-01-19'::date),
        ('Pfizer 3-4',                  'Pfizer 3-4',                     'B0021',        '2025-09-14'::date),
        ('Afluria MDV',                 'Afluria MDV',                    'P100710085',   '2025-06-30'::date),
        ('Afluria PFS',                 'Afluria PFS',                    'AX6340A',      '2026-06-30'::date),
        ('Flucelvax MDV',               'Flucelvax MDV',                  null,           null),
        ('Flucelvax PFS',               'Flucelvax PFS',                  '409414',       '2026-06-30'::date),
        ('Fluad',                       'Fluad',                          '407273',       '2026-06-12'::date),
        ('Fluarix PFS',                 'Fluarix PFS',                    null,           null),
        ('Fluzone PFS',                 'Fluzone PFS',                    null,           null),
        ('Fluzone HD',                  'Fluzone HD',                     null,           null),
        ('Flulaval',                    'Flulaval',                       null,           null),
        ('FluMist',                     'FluMist (age 2-49)',             'YH2784B',      '2025-12-08'::date),
        ('Arexvy',                      'Arexvy',                         '4BN95',        '2025-10-25'::date),
        ('Boostrix',                    'Boostrix',                       'L252X',        '2028-09-16'::date),
        ('Shingrix',                    'Shingrix',                       '4994A',        '2028-09-01'::date),
        ('Engerix 20',                  'Engerix 20 (age 20+)',           '2GZ34',        '2028-08-14'::date),
        ('Prevnar 20',                  'Prevnar 20',                     'MM0527',       '2027-03-31'::date),
        ('Pneumovax 23',                'Pneumovax 23',                   null,           null),
        ('Gardasil',                    'Gardasil',                       'Z016807',      '2027-12-17'::date),
        ('Menveo',                      'Menveo',                         'AMVB094A',     '2027-09-30'::date),
        ('Vaqta adult',                 'Vaqta adult',                    'Z012608',      '2027-05-04'::date),
        ('Typhim Vi',                   'Typhim Vi',                      'Y2A031M',      '2027-06-30'::date),
        ('MMR',                         'MMR-II',                         'Z017518',      '2027-11-17'::date),
        ('Abrysvo',                     'Abrysvo',                        'MM9160',       '2026-10-31'::date),
        ('Priorix',                     'Priorix',                        'XX9N4',        '2026-06-01'::date),
        ('Capvaxive',                   'Capvaxive',                      'Z016522',      '2027-08-16'::date)
    ) as t(seed_name, lookup_name, lot_number, expiration)
  loop
    if seed.lot_number is null then
      continue; -- blank lot/exp: vaccine catalog entry only, no lot row.
    end if;

    -- Deterministic pick when a name matches multiple dose-specific rows
    -- (see DOSE-AMBIGUOUS NAME NOTE above) — lowest short_code wins.
    select id into vid
    from vaccine
    where vaccine.name = seed.lookup_name
    order by short_code
    limit 1;

    if vid is null then
      raise notice 'seed_lots: no vaccine row found for %, skipping lot %', seed.lookup_name, seed.lot_number;
      continue;
    end if;

    insert into lot (vaccine_id, lot_number, expiration, status)
    select vid, seed.lot_number, seed.expiration, 'active'
    where not exists (
      select 1 from lot where lot.vaccine_id = vid and lot.lot_number = seed.lot_number
    );
  end loop;
end $$;
