import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isMissingTableError } from "@/lib/schema-degradation";
import { normalizeNdc } from "@/lib/ndc";

/**
 * GET/PUT /api/ordering/targets — staff-set target on-hand balances, by
 * NDC or by vaccine group (Will msg 904; see lib/ordering-targets.ts for
 * how these combine with the auto-recommended target). Backed by
 * supabase/migrations/0011_on_hand_ndc_and_targets.sql's `ordering_target`
 * table, which is MIGRATION FILE ONLY per Will's brief — both routes
 * degrade to `{ pending: true }` / a 503-free no-op when that table
 * doesn't exist yet, same posture as GET /api/on-hand/address before
 * 0010.
 *
 * RESPONSE CONTRACTS:
 *   GET  -> { targets: [{ scope, key, targetOnHand }] }
 *           or, before 0011 has run: { targets: [], pending: true }
 *   PUT  body { scope: "ndc" | "group", key: string, targetOnHand: number | null }
 *        targetOnHand === null DELETES the override (falls back to the
 *        recommended target). A non-null value must be a non-negative
 *        integer. `key` is normalized server-side before persisting —
 *        for scope "ndc" via lib/ndc.ts's normalizeNdc (digits only, so
 *        a dashed NDC from any client still lands on the SAME key the
 *        recommendation route's ndcOverrides lookup uses; rejected as
 *        400 if nothing digit-shaped remains), for scope "group" just
 *        trimmed.
 *        -> { scope, key, targetOnHand } (targetOnHand: null after a delete;
 *           `key` echoed back NORMALIZED, not necessarily what was sent)
 *           or, before 0011 has run: { pending: true }
 */

type TargetRow = { scope: string; key: string; target_on_hand: number };

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { data, error } = await supabase.from("ordering_target").select("scope, key, target_on_hand");

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ targets: [], pending: true });
    }
    console.error("GET /api/ordering/targets: failed to load targets", error);
    return NextResponse.json({ error: "Failed to load ordering targets." }, { status: 500 });
  }

  const targets = ((data as TargetRow[] | null) ?? []).map((row) => ({
    scope: row.scope,
    key: row.key,
    targetOnHand: row.target_on_hand,
  }));

  return NextResponse.json({ targets });
}

function isValidScope(value: unknown): value is "ndc" | "group" {
  return value === "ndc" || value === "group";
}

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
  const { scope, key, targetOnHand } = body as Record<string, unknown>;

  if (!isValidScope(scope)) {
    return NextResponse.json({ error: 'scope must be "ndc" or "group".' }, { status: 400 });
  }
  if (typeof key !== "string" || key.trim().length === 0) {
    return NextResponse.json({ error: "key is required." }, { status: 400 });
  }
  if (
    targetOnHand !== null &&
    (typeof targetOnHand !== "number" || !Number.isFinite(targetOnHand) || !Number.isInteger(targetOnHand) || targetOnHand < 0)
  ) {
    return NextResponse.json({ error: "targetOnHand must be a non-negative integer, or null to clear it." }, { status: 400 });
  }

  // Normalize `key` server-side (review fix, V-ordering-targets
  // 2026-09-08) so a client can send a dashed NDC ("70461-0123-03") and
  // still land under the SAME digits-only key the recommendation route
  // looks up (lib/ndc.ts's normalizeNdc — every ndcOverrides[row.ndc]
  // lookup there is keyed by the digits-only form). A group key is just
  // trimmed — group names are exact display-name strings
  // (lib/vaccine-group-catalog.ts), not NDCs.
  const normalizedKey = scope === "ndc" ? normalizeNdc(key) : key.trim();
  if (!normalizedKey) {
    return NextResponse.json({ error: "key is not a valid NDC (no digits found)." }, { status: 400 });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  if (targetOnHand === null) {
    const { error } = await supabase.from("ordering_target").delete().eq("scope", scope).eq("key", normalizedKey);
    if (error) {
      if (isMissingTableError(error)) {
        return NextResponse.json({ pending: true });
      }
      console.error("PUT /api/ordering/targets: failed to delete target", error);
      return NextResponse.json({ error: "Failed to clear the target." }, { status: 500 });
    }
    return NextResponse.json({ scope, key: normalizedKey, targetOnHand: null });
  }

  const { error } = await supabase
    .from("ordering_target")
    .upsert(
      { scope, key: normalizedKey, target_on_hand: targetOnHand, updated_at: new Date().toISOString() },
      { onConflict: "scope,key" }
    );

  if (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json({ pending: true });
    }
    console.error("PUT /api/ordering/targets: failed to save target", error);
    return NextResponse.json({ error: "Failed to save the target." }, { status: 500 });
  }

  return NextResponse.json({ scope, key: normalizedKey, targetOnHand });
}
