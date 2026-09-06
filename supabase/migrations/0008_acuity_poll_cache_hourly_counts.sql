-- Vaccine Assist — acuity_poll_cache hourly breakdown
--
-- V-T-hourly-table (Will, 2026-09-05): the /appointments dashboard's new
-- hourly-breakdown table needs a per-(date, hour) aggregate alongside the
-- existing per-(date, vaccineName) `counts` column. Additive column, same
-- posture as `possibly_truncated` (0004): a row cached before this shipped
-- simply has the column's default ('[]'::jsonb) rather than a null or a
-- missing key, so cloud/lib/acuity-poll-cache.ts's getCachedCounts never
-- has to special-case a genuinely absent value — the hourly table on such
-- a stale row just renders empty until the next real poll repopulates it.
alter table acuity_poll_cache
  add column if not exists hourly_counts jsonb not null default '[]'::jsonb;
