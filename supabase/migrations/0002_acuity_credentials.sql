-- Vaccine Assist — Acuity credentials storage
--
-- V-Q4 (2026-08-16): Will asked for the Acuity User ID / API key to be
-- entered in the app itself instead of handed over as env vars. This
-- table backs that settings UI (see app/settings/page.tsx and
-- app/api/settings/acuity/route.ts).
--
-- Singleton row (id is pinned to 1 via the check constraint) — there is
-- one shared pharmacy login and one Acuity account, so there's nothing
-- to key this by. `lib/acuity-credentials.ts` reads this row first and
-- falls back to ACUITY_USER_ID/ACUITY_API_KEY env vars if it's empty.
--
-- Storage note (prototype tradeoff, same one already called out for the
-- desktop app's AutoLoginConfigService): acuity_api_key is stored in
-- plaintext, not app-level-encrypted. Supabase encrypts at rest, and RLS
-- below denies ALL access to `authenticated`/`anon` — only the
-- service-role key (server-only, never shipped to the browser) can read
-- or write this table. That's a deliberate departure from the
-- "authenticated can do everything" policy used for the other tables in
-- 0001_init.sql: those are business data the shared login needs direct
-- read access to, while this is a write credential to a third-party
-- scheduling account. It gets no direct client access at all — only
-- through the settings API route, which strips the key before it's ever
-- included in a response sent to the browser.
create table if not exists acuity_credentials (
  id integer primary key default 1 check (id = 1),
  acuity_user_id text not null,
  acuity_api_key text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create trigger acuity_credentials_set_updated_at before update on acuity_credentials
  for each row execute function set_updated_at();

alter table acuity_credentials enable row level security;
-- Deliberately no policies: RLS with zero policies denies all access to
-- `anon` and `authenticated`. Only the service-role key (which bypasses
-- RLS entirely) can read/write, and that key only ever lives server-side.
