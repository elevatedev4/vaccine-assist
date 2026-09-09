-- Vaccine Assist — per-account inbound on-hand email address
-- (V-onhand-account-address, Will 2026-09-08)
--
-- MIGRATION FILE ONLY per Will's brief — not run against any database as
-- part of this change.
--
-- Rationale (Will, verbatim): the daily on-hand report Pioneer emails
-- carries no pharmacy-identifying info, so once more than one account
-- exists the app has no way to know whose stock a given email belongs
-- to. The fix is the same one ~/claude/pharmacy-kpis already ships
-- (lib/emailIn/address.ts there): generate a per-account address with an
-- unguessable token in the local part, so "which account" is decided
-- entirely by WHICH address a report was sent to, not by anything in the
-- email body. Account = Supabase auth user id (this app is still one
-- shared pharmacy login today, but each user created later gets its own
-- row/address here without any further migration).
--
-- Address shape (cloud/lib/on-hand/address.ts is the single source of
-- truth for the string format): vaccines-<32+ hex chars>@in.orchardsdrug.com.
-- The router forwarding *@in.orchardsdrug.com to this app's SES webhook is
-- being changed separately to forward every recipient whose local part
-- starts with "vaccines-" (today only the single fixed
-- vaccines-onhand@in.orchardsdrug.com address exists and is NOT a valid
-- token per parseToken — the webhook logs and ignores it, same as any
-- other unrecognized recipient, once this ships).

create table if not exists inbound_email_address (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  token text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_received_at timestamptz
);

-- Every inbound email lookup is BY TOKEN (parsed out of the recipient
-- address) — this is the webhook's hot path, so it gets its own index
-- even though token is already unique (a unique constraint's backing
-- index would cover this too, but naming it explicitly matches this
-- repo's convention of an explicit index per query pattern, e.g.
-- on_hand_count_vaccine_received_idx in 0006).
create index if not exists inbound_email_address_token_idx
  on inbound_email_address (token);

-- Same posture as on_hand_count/acuity_credentials/acuity_poll_cache
-- (0002/0003/0006): RLS enabled with zero policies denies all
-- anon/authenticated access. Only the service-role key (server-only —
-- the SES webhook, the on-hand upload route, and GET /api/on-hand/address)
-- reads/writes this table; the browser/desktop app never queries it
-- directly. No PHI here (a token and a timestamp), but no reason to loosen
-- this either.
alter table inbound_email_address enable row level security;

-- Links each on_hand_count row to the account it belongs to, and how it
-- arrived. Both nullable-by-default-value additive columns, same
-- "add column if not exists, old rows just get the default" posture as
-- 0008/0009 — every row inserted before this migration ran (the whole
-- single-pharmacy history to date) keeps inbound_email_address_id NULL
-- and source 'email', which the app treats as "legacy, belongs to
-- whichever account is asking" (see GET /api/on-hand/address's `hasData`
-- and the Ordering recommendation route's on-hand query) rather than
-- orphaned data. `source` values in use: 'email' (arrived via the SES
-- webhook, the default) and 'upload' (POST /api/on-hand/upload, a
-- one-time manual file). No DB check constraint enforcing that small
-- fixed set — same "no DB constraint for an app-level invariant" posture
-- 0009 already uses for physician_rule.vaccine_group's paired columns.
alter table on_hand_count
  add column if not exists inbound_email_address_id uuid references inbound_email_address (id);

alter table on_hand_count
  add column if not exists source text not null default 'email';

-- Supports the Ordering recommendation route's per-account on-hand query
-- (WHERE inbound_email_address_id = <this account> OR IS NULL).
create index if not exists on_hand_count_inbound_email_address_idx
  on on_hand_count (inbound_email_address_id);
