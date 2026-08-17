-- Vaccine Assist — Acuity poll cache
--
-- Phase 2 v1 (2026-08-16): backs the real app/api/acuity/poll/route.ts.
-- Appointments are fetched on-demand (staff check workload live — this is
-- NOT a cron), but every hit re-fetching from Acuity would be wasteful and
-- slow, so results are cached ~5 min (ACUITY_POLL_CACHE_SECONDS) here.
--
-- A Supabase table instead of an in-memory cache because this route runs
-- as Vercel serverless functions — separate invocations (even seconds
-- apart) can land on different lambda instances with no shared memory, so
-- an in-memory cache would miss constantly and defeat the point.
--
-- Keyed by the requested date range (range_key = "minDate_maxDate"), one
-- row per distinct range. counts holds ONLY the aggregated, PHI-stripped
-- output of aggregateAppointmentCounts() (lib/acuity-client.ts) — no
-- patient data ever reaches this table.
create table if not exists acuity_poll_cache (
  range_key text primary key,
  range_start date not null,
  range_end date not null,
  counts jsonb not null,
  computed_at timestamptz not null default now()
);

create index if not exists acuity_poll_cache_computed_at_idx on acuity_poll_cache (computed_at);

-- Same posture as acuity_credentials (0002): RLS enabled with zero
-- policies denies all access to anon/authenticated. Only the service-role
-- key (server-only, used exclusively by the poll route) can read/write —
-- the dashboard never queries this table directly, only through the
-- authenticated poll API.
alter table acuity_poll_cache enable row level security;
