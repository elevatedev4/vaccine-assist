import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * STUB — Acuity Scheduling appointment-count polling.
 *
 * Real plan (phase 2+): call the Acuity API (ACUITY_USER_ID/
 * ACUITY_API_KEY) for upcoming appointments, aggregate counts by
 * vaccine type + date (no PHI — counts only, matching the current
 * Google-Sheets dashboard), upsert into the `appointment_count` table,
 * and cache the result for ACUITY_POLL_CACHE_SECONDS (default 300 = 5
 * min) so this route can be hit frequently without hammering Acuity.
 *
 * Phase 1: no live calls. Returns a fixed stub shape so the desktop app
 * and future reporting UI can be built against a stable contract before
 * Acuity credentials exist.
 */

let cachedAt = 0;
let cachedResult: unknown = null;

export async function GET() {
  const cacheSeconds = env.acuityPollCacheSeconds();
  const now = Date.now();

  if (cachedResult && now - cachedAt < cacheSeconds * 1000) {
    return NextResponse.json({ ...(cachedResult as object), cacheHit: true });
  }

  if (!env.acuityUserId() || !env.acuityApiKey()) {
    const stub = {
      stub: true,
      message:
        "Acuity credentials are not configured. This endpoint is a phase-1 stub — " +
        "wire up ACUITY_USER_ID/ACUITY_API_KEY and replace this handler with a real poll.",
      cacheSeconds,
      counts: [] as Array<{ date: string; vaccineType: string; count: number }>,
    };
    cachedResult = stub;
    cachedAt = now;
    return NextResponse.json({ ...stub, cacheHit: false });
  }

  // TODO(phase 2): fetch from Acuity, aggregate, upsert appointment_count.
  const result = {
    stub: true,
    message: "Acuity credentials found, but polling is not implemented yet.",
    cacheSeconds,
    counts: [] as Array<{ date: string; vaccineType: string; count: number }>,
  };
  cachedResult = result;
  cachedAt = now;
  return NextResponse.json({ ...result, cacheHit: false });
}
