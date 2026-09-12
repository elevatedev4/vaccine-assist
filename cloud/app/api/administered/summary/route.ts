import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { administeredSummary } from "@/lib/administered/store";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 365;

/**
 * GET /api/administered/summary?days=7 — rolling last-N-days summary of
 * ingested per-dose vaccination-log data (V-administered-ingest, Will
 * 2026-09-12). Authed exactly like every other admin route in this app
 * (requireAuthenticatedUser — see app/api/inbound/attachments/route.ts).
 * `days` defaults to 7, must be a positive integer, capped at 365 to
 * bound how many app_setting reads one request can trigger (one read per
 * day in the window — see lib/administered/store.ts's administeredSummary).
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const daysParam = searchParams.get("days");
  const days = daysParam === null ? DEFAULT_DAYS : Number(daysParam);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an integer between 1 and ${MAX_DAYS}.` }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const summary = await administeredSummary(supabase, { days });
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
