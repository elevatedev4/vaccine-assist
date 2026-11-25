-- Vaccine Assist — add the Pfizer 5-11 product row (Will 2026-11-25:
-- "Pfizer 5-11, Comirnaty 2026-27 (5-11y) 0.3 ml vial 00069-2609-10. For ages
-- 5-11 only. Cash rpice 147.99. ... the macro code is comirnaty511").
--
-- Data only, additive and idempotent: one vaccine row keyed on short_code
-- `comirnaty511` (upsert — re-running updates the same row, never adds a
-- second), then the 5-11 age rule (same statements as 0016, repeated here so
-- one run does both; 0016 stays valid and harmless to run again).
-- Name has no parentheses on purpose: lib/vaccine-product-catalog.ts matches
-- "Comirnaty 2026-27 5-11y" to the 5-11 catalog entry; quantity (0.3) and the
-- sig come from code (lib/entry-defaults.ts), like the other COVID rows.

insert into vaccine (name, ndc, dose, short_code, cash_price_cents, active)
values ('Comirnaty 2026-27 5-11y', '00069-2609-10', '0.3 mL', 'comirnaty511', 14799, true)
on conflict (short_code) do update
  set name = excluded.name,
      ndc = excluded.ndc,
      dose = excluded.dose,
      cash_price_cents = excluded.cash_price_cents,
      active = true,
      updated_at = now();

delete from eligibility_rule
where vaccine_id in (select id from vaccine where short_code = 'comirnaty511');

insert into eligibility_rule (vaccine_id, min_age, max_age, condition_note, pregnancy_warning, priority)
select id, 5, 11, null, false, 0
from vaccine where short_code = 'comirnaty511';
