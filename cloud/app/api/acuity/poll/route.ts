import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentials } from "@/lib/acuity-credentials";

/**
 * STUB — Acuity Scheduling appointment-count polling.
 *
 * Real plan (phase 2+): call the Acuity API for upcoming appointments,
 * aggregate counts by vaccine type + date (no PHI — counts only,
 * matching the current Google-Sheets dashboard), upsert into the
 * `appointment_count` table, and cache the result for
 * ACUITY_POLL_CACHE_SECONDS (default 300 = 5 min) so this route can be
 * hit frequently without hammering Acuity.
 *
 * Credentials come from getAcuityCredentials() — the `acuity_credentials`
 * table (set via /settings, per V-Q4) first, falling back to
 * ACUITY_USER_ID/ACUITY_API_KEY env vars if that row doesn't exist.
 *
 * Phase 1: no live calls, and today's stub payload has nothing sensitive
 * in it — but the auth gate is added now anyway (same as the other three
 * data routes) so phase 2 doesn't ship real appointment/scheduling data
 * behind a route someone forgot was still wide open.
 */

let cachedAt = 0;
let cachedResult: unknown = null;

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const cacheSeconds = env.acuityPollCacheSeconds();
  const now = Date.now();

  if (cachedResult && now - cachedAt < cacheSeconds * 1000) {
    return NextResponse.json({ ...(cachedResult as object), cacheHit: true });
  }

  const credentials = await getAcuityCredentials();

  if (!credentials) {
    const stub = {
      stub: true,
      message:
        "Acuity credentials are not configured. This endpoint is a phase-1 stub — " +
        "set them in Settings → Acuity (or ACUITY_USER_ID/ACUITY_API_KEY as a " +
        "fallback), then replace this handler with a real poll.",
      cacheSeconds,
      counts: [] as Array<{ date: string; vaccineType: string; count: number }>,
    };
    cachedResult = stub;
    cachedAt = now;
    return NextResponse.json({ ...stub, cacheHit: false });
  }

  // TODO(phase 2): fetch from Acuity using `credentials`, aggregate, upsert appointment_count.
  const result = {
    stub: true,
    message: `Acuity credentials found (source: ${credentials.source}), but polling is not implemented yet.`,
    cacheSeconds,
    counts: [] as Array<{ date: string; vaccineType: string; count: number }>,
  };
  cachedResult = result;
  cachedAt = now;
  return NextResponse.json({ ...result, cacheHit: false });
}
