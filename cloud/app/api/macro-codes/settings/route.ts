import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import {
  getMacroDoseCounts,
  isValidDoseCountsMap,
  updateMacroDoseCounts,
} from "@/lib/macro-codes-settings";

/**
 * GET/PUT /api/macro-codes/settings — per-product dose-count overrides
 * for the /macro-codes tab's "Doses" input (Will's brief). Auth like
 * every other desktop/cloud-facing route (requireAuthenticatedUser).
 * Backed by the generic `app_setting` table (see
 * lib/macro-codes-settings.ts's doc comment).
 *
 * RESPONSE CONTRACTS:
 *   GET -> { doseCounts: Record<string, number>, pending: boolean }
 *   PUT body { doseCounts: Record<string, number> } — a PARTIAL patch
 *       (typically just the one product the client just changed; a
 *       full map is also accepted, it's just merged the same way) —
 *       MERGED server-side on top of whatever's currently saved (see
 *       lib/macro-codes-settings.ts's updateMacroDoseCounts doc comment
 *       for why: two devices each PUTting a stale full local copy could
 *       otherwise clobber each other's change to a DIFFERENT product)
 *       -> { doseCounts: <merged map> } on success
 *       or, before app_setting exists: { pending: true } (200, not an
 *          error — same "don't crash, just don't persist yet" posture
 *          as PUT /api/lots/settings)
 */
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

  try {
    const { doseCounts, pending } = await getMacroDoseCounts(supabase);
    return NextResponse.json({ doseCounts, pending });
  } catch (err) {
    console.error("GET /api/macro-codes/settings: failed to load macro_dose_counts", err);
    return NextResponse.json({ error: "Failed to load macro codes settings." }, { status: 500 });
  }
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
  const { doseCounts } = body as Record<string, unknown>;
  if (!isValidDoseCountsMap(doseCounts)) {
    return NextResponse.json({ error: "doseCounts must be an object mapping productKey to an integer 1-4." }, { status: 400 });
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

  try {
    const { doseCounts: merged, pending } = await updateMacroDoseCounts(supabase, doseCounts);
    if (pending) return NextResponse.json({ pending: true });
    return NextResponse.json({ doseCounts: merged });
  } catch (err) {
    console.error("PUT /api/macro-codes/settings: failed to save macro_dose_counts", err);
    return NextResponse.json({ error: "Failed to save the setting." }, { status: 500 });
  }
}
