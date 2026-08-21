-- Vaccine Assist — on-hand stock counts (Ordering tab, V-ordering 2026-08-19/20)
--
-- Backs the extended SES inbound webhook (app/api/webhooks/ses/route.ts):
-- every line parsed out of a staff-sent on-hand-count email (see
-- cloud/lib/on-hand-parser.ts for the exact expected email format) gets a
-- row here, matched or not — nothing is dropped, so an unmatched/unparsed
-- line stays visible for troubleshooting instead of silently vanishing.
--
-- One row per LINE per EMAIL (append-only, not upserted) — history is
-- kept so app/api/ordering/recommendation/route.ts can always ask for
-- "the latest matched row per vaccine" rather than this table only ever
-- holding a single current snapshot.
create table if not exists on_hand_count (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  raw_line text not null,
  vaccine_name_raw text not null,
  quantity integer,
  vaccine_id uuid references vaccine (id),
  matched boolean not null default false,
  created_at timestamptz not null default now()
);

-- Supports "latest matched row per vaccine_id" (the recommendation
-- endpoint's core lookup) — filter matched = true, then order by
-- (vaccine_id, received_at desc) to take the first row per vaccine.
create index if not exists on_hand_count_vaccine_received_idx
  on on_hand_count (vaccine_id, received_at desc);

-- Same posture as acuity_poll_cache/acuity_credentials (0002/0003): RLS
-- enabled with zero policies denies all access to anon/authenticated.
-- Only the service-role key (server-only — the SES webhook and the
-- recommendation route, both server code) can read/write this table; no
-- PHI here regardless (aggregate stock counts only), but there's no
-- reason for the browser/desktop app to ever query it directly.
alter table on_hand_count enable row level security;

-- DEFERRED, same note as acuity_poll_cache: no pruning job for old rows
-- yet. Low volume for now (one pharmacy, roughly one email's worth of
-- lines per day) — revisit if this table ever grows large enough to
-- matter.
