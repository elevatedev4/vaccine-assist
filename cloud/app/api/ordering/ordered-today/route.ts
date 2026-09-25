import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/schema-degradation";
import { todayInChicago } from "@/lib/chicago-date";
import { isValidPackagesOrdered } from "@/lib/ordering-ordered-today";

/**
 * PUT /api/ordering/ordered-today — the "Ordered today" packages field
 * on the Ordering tab's "To order" table (V-ordering-ordered-today,
 * Will 2026-09-25; see lib/ordering-ordered-today.ts for the pure
 * remaining/grouping math this feeds). Backed by
 * supabase/migrations/0015_ordering_ordered_today.sql's
 * `ordering_ordered_today` table, which is MIGRATION FILE ONLY per
 * standing convention — this route degrades to `{ pending: true }`
 * (200, not an error) when that table doesn't exist yet, same posture
 * as PUT /api/ordering/targets before 0011 and PUT /api/ordering/settings
 * before 0012.
 *
 * There is no GET here: GET /api/ordering/recommendation already reads
 * this table itself (server-side, alongside ordering_target) and
 * returns each row's `orderedToday`/`remaining` fields directly, so the
 * page never needs a separate read path for this data.
 *
 * `key` is NOT re-normalized here (contrast PUT /api/ordering/targets,
 * which normalizes a raw NDC via lib/ndc.ts's normalizeNdc): the value
 * the page sends is always a recommendation row's own `key` field
 * exactly as GET /api/ordering/recommendation returned it (a digits-only
 * NDC, or "vaccine:<id>" for a no-NDC product) — already normalized
 * upstream, and not necessarily NDC-shaped at all. Only trimmed and
 * checked for non-emptiness, same as PUT /api/ordering/targets' own
 * group-scope key handling.
 *
 * The day is always TODAY in America/Chicago (lib/chicago-date.ts's
 * todayInChicago) — never client-supplied — so a stale client can't
 * accidentally write yesterday's (or some other day's) row.
 *
 * RESPONSE CONTRACT:
 *   PUT body { key: string, orderedToday: number }  (orderedToday: a
 *       non-negative integer PACKAGE count; 0 is valid — "nothing
 *       ordered yet today", not a clear/delete signal, since a new
 *       Chicago day always starts every key back at 0 with no row on
 *       file)
 *       -> { key: string, orderDate: "YYYY-MM-DD", orderedToday: number } on success
 *       or, before 0015 has run: { pending: true } (200)
 */

export async function PUT(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }
  const { key, orderedToday } = body as Record<string, unknown>;

  if (typeof key !== "string" || key.trim().length === 0) {
    return NextResponse.json({ error: "key is required." }, { status: 400 });
  }
  if (!isValidPackagesOrdered(orderedToday)) {
    return NextResponse.json({ error: "orderedToday must be a non-negative integer." }, { status: 400 });
  }

  const normalizedKey = key.trim();
  const orderDate = todayInChicago();

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { error } = await supabase
    .from("ordering_ordered_today")
    .upsert(
      { key: normalizedKey, order_date: orderDate, packages_ordered: orderedToday, updated_at: new Date().toISOString() },
      { onConflict: "key,order_date" }
    );

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ pending: true });
    }
    console.error("PUT /api/ordering/ordered-today: failed to save ordered-today count", error);
    return NextResponse.json({ error: "Failed to save the ordered-today count." }, { status: 500 });
  }

  return NextResponse.json({ key: normalizedKey, orderDate, orderedToday });
}
