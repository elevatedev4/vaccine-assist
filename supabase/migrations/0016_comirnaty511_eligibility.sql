-- Vaccine Assist — age gate for Pfizer 5-11 (Comirnaty 2026-27 5-11y),
-- macro/short code `comirnaty511` (Will 2026-11-25: "For ages 5-11 only").
--
-- MIGRATION FILE ONLY per standing convention — not run against any
-- database as part of this change; the coder writes the migration, the
-- manager/Will applies it from his own terminal
-- (scripts/apply-migration.mjs).
--
-- ORDER OF OPERATIONS: run this AFTER the vaccine row exists (created with
-- POST /api/vaccines with short_code "comirnaty511"). It is a
-- select-by-short_code insert, so run before the row exists it inserts zero
-- rows and changes nothing — re-run it once the row is there. With no rule a
-- vaccine is allowed at every age (GET /api/eligibility/for-age), so the
-- product would show for adults until this has been applied.
--
-- Idempotent: it deletes this one product's existing rules first, then
-- inserts the single 5-11 rule (same rule supabase/seed/eligibility_rules.sql
-- now carries for a fresh database). It touches no other product's rules.
--
-- Effect (lib/eligibility.ts): a patient under 5 or over 11 is BLOCKED for
-- this product ("below the minimum age of 5" / "above the maximum age of
-- 11"), exactly like every other age-limited product.

delete from eligibility_rule
where vaccine_id in (select id from vaccine where short_code = 'comirnaty511');

insert into eligibility_rule (vaccine_id, min_age, max_age, condition_note, pregnancy_warning, priority)
select id, 5, 11, null, false, 0
from vaccine where short_code = 'comirnaty511';
