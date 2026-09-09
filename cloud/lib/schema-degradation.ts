/**
 * Graceful degradation for columns added by
 * supabase/migrations/0009_lots_bud_vaccine_defaults.sql
 * (lot.beyond_use_date, vaccine.quantity, vaccine.directions,
 * physician_rule.vaccine_group) — that migration is deliberately NOT run
 * as part of this change (Will's brief: "MIGRATION FILE ONLY... do not
 * run anything against the DB"), so every route touching one of these
 * columns must keep working against a database that hasn't picked it up
 * yet, and start using it automatically once it has, with no code
 * change or redeploy required.
 *
 * Strategy: try the query/write WITH the new column(s) first; if
 * Postgres/PostgREST reports the column doesn't exist, retry WITHOUT it
 * and surface a `*Supported: false` flag the API response carries so the
 * client can hide that field with a "pending migration" note rather than
 * silently dropping data or crashing the page. This "try, catch, retry"
 * shape costs nothing extra once the migration has run (a single query,
 * same as before) and only pays for a second round trip during the
 * window before it has.
 */

/**
 * True when `error` looks like Postgres/PostgREST reporting that a
 * referenced column doesn't exist. Checked by MESSAGE TEXT (not only a
 * single error code) because Supabase's JS client surfaces this failure
 * two different ways depending on where it originates:
 *  - Postgres itself raises `undefined_column`, SQLSTATE `42703`, for a
 *    `.eq()`/insert/update referencing an unknown column.
 *  - PostgREST's own schema-cache miss (a request shape its cached
 *    schema doesn't recognize) surfaces as code `PGRST204`.
 * Both cases put "column ... does not exist" (or, for PostgREST's cache
 * message, "could not find ... column") in the message, so matching on
 * that text is the belt-and-suspenders check here rather than trusting
 * one specific code shape.
 */
export function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42703" || code === "PGRST204") return true;

  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  if (!message.includes("column")) return false;
  return message.includes("does not exist") || message.includes("could not find");
}

/**
 * Same idea as isMissingColumnError, but for a whole TABLE that hasn't
 * been created yet — supabase/migrations/0010_inbound_email_address.sql
 * (V-onhand-account-address) adds the `inbound_email_address` table
 * itself, not just columns on an existing one, so callers that touch it
 * before that migration has run (cloud/lib/on-hand/address.ts,
 * app/api/on-hand/address/route.ts) need this instead:
 *  - Postgres raises `undefined_table`, SQLSTATE `42P01`, for a query
 *    against an unknown relation.
 *  - PostgREST's schema-cache miss for an unrecognized table surfaces as
 *    code `PGRST205` ("Could not find the table ... in the schema
 *    cache"), the table-level sibling of PGRST204 above.
 * Message-text fallback matches the same belt-and-suspenders posture as
 * isMissingColumnError.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "42P01" || code === "PGRST205") return true;

  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  if (!message.includes("table") && !message.includes("relation")) return false;
  return message.includes("does not exist") || message.includes("could not find");
}
