-- Vaccine Assist — acuity_poll_cache truncation flag
--
-- Reviewer fix (2026-08-16): fetchAppointmentsForRange (lib/acuity-client.ts)
-- hits Acuity's documented `max=100` cap with no offset/pagination param —
-- a full page is a signal (not a certainty) that more appointments exist
-- in the range than were fetched. That signal must survive a cache hit
-- too, so a cached truncated result still warns instead of silently
-- looking complete.
alter table acuity_poll_cache
  add column if not exists possibly_truncated boolean not null default false;

-- DEFERRED: still no pruning job for old rows — see the comment in
-- cloud/lib/acuity-poll-cache.ts. The poll route now caps requested
-- ranges at 31 days (MAX_RANGE_DAYS), which bounds the size of any one
-- row, but rows still accumulate roughly one per day as the dashboard's
-- default range shifts. Fine at current (single-pharmacy) volume.
