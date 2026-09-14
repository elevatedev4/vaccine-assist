-- Vaccine Assist — session management for Settings → Sessions (V-sessions,
-- Will 2026-09-13, verbatim): "If a user logs in once on a computer, you
-- should make that last for 90 days without requiring a login again...
-- Also include a page in the cloud to manage these sessions and revoke
-- them as needed (ex: sign out everywhere button)."
--
-- MIGRATION FILE ONLY — not run against any database as part of this
-- change (per standing convention: the coder writes the migration, the
-- manager applies it). See cloud/lib/schema-degradation.ts's
-- isMissingFunctionError for how GET/DELETE /api/sessions keep working
-- (returning { pending: true }) before this has been applied.
--
-- auth.sessions (created_at, updated_at, refreshed_at, user_agent, ip)
-- is Supabase-managed and not exposed to PostgREST's default schema
-- cache (only `public`/`graphql_public` are exposed by default, and
-- reconfiguring db.schemas requires dashboard/project-config access this
-- migration shouldn't assume) — so list/revoke go through two
-- SECURITY DEFINER functions in `public` instead of
-- `supabase.schema('auth').from('sessions')`.
--
-- Both functions take the caller's own `uid` (looked up server-side from
-- the already-verified access token in requireAuthenticatedUser, never
-- taken from client input) and scope every read/delete to
-- `user_id = uid` — a service-role caller cannot use these to touch
-- another user's sessions by passing a different uid, since app/api's
-- own auth check is what supplies `uid` in the first place. Execute is
-- granted only to service_role (same posture as the app's tables:
-- server-only access, never queried directly by the browser/desktop
-- app), and revoked from PUBLIC first since Postgres grants EXECUTE on
-- new functions to PUBLIC by default.

create or replace function public.list_my_sessions(uid uuid)
returns table (
  id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip text
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.created_at, s.updated_at, s.refreshed_at, s.user_agent, s.ip::text
  from auth.sessions s
  where s.user_id = uid
  order by s.created_at desc;
$$;

revoke all on function public.list_my_sessions(uuid) from public;
grant execute on function public.list_my_sessions(uuid) to service_role;

-- Returns true if a row was actually deleted (false if target_id
-- doesn't exist or belongs to a different user) so the route can tell
-- "revoked" apart from "nothing to revoke" without a second query.
create or replace function public.revoke_my_session(uid uuid, target_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from auth.sessions
  where id = target_id and user_id = uid;
  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

revoke all on function public.revoke_my_session(uuid, uuid) from public;
grant execute on function public.revoke_my_session(uuid, uuid) to service_role;
