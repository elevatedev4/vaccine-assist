import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { VaccineCount } from "@/lib/acuity-client";

/**
 * Server-side cache for app/api/acuity/poll/route.ts, backed by the
 * `acuity_poll_cache` table (supabase/migrations/0003_acuity_poll_cache.sql).
 * A Supabase table rather than an in-memory cache because this route runs
 * as Vercel serverless functions with no shared memory across invocations
 * — see that migration's comment for the full rationale.
 *
 * Phase 1/2 tolerance: if Supabase isn't configured yet (or the migration
 * hasn't been applied), both functions fail soft — getCachedCounts()
 * returns null (treated as a cache miss) and setCachedCounts() silently
 * no-ops — matching the fallback style already used by
 * lib/acuity-credentials.ts. A cache is never load-bearing for
 * correctness, only for avoiding redundant Acuity calls.
 *
 * DEFERRED: no pruning job exists for old rows yet. The poll route caps
 * requested ranges at 31 days (MAX_RANGE_DAYS in the route), which bounds
 * how large any single row's `counts` payload can get, but a new row is
 * still written per distinct (range_start, range_end) pair — e.g. the
 * dashboard's default "today..today+7" range shifts daily, so the table
 * grows by roughly one row per day over time. Low volume/low cost for
 * now (this is a single-pharmacy prototype); revisit with either a
 * scheduled prune-rows-older-than-N-days job or a unique constraint on
 * something coarser than the exact range if it ever becomes a problem.
 */

export type CachedPoll = {
  counts: VaccineCount[];
  possiblyTruncated: boolean;
  computedAt: string;
};

function rangeKey(minDate: string, maxDate: string): string {
  return `${minDate}_${maxDate}`;
}

export async function getCachedCounts(
  minDate: string,
  maxDate: string,
  ttlSeconds: number
): Promise<CachedPoll | null> {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("acuity_poll_cache")
      .select("counts, computed_at, possibly_truncated")
      .eq("range_key", rangeKey(minDate, maxDate))
      .maybeSingle();

    if (error || !data) return null;

    const computedAt = new Date(data.computed_at);
    if (Number.isNaN(computedAt.getTime())) return null;
    if (Date.now() - computedAt.getTime() >= ttlSeconds * 1000) return null;

    return {
      counts: data.counts as VaccineCount[],
      possiblyTruncated: Boolean(data.possibly_truncated),
      computedAt: data.computed_at,
    };
  } catch {
    // Supabase not configured / table missing — treat as a cache miss.
    return null;
  }
}

export async function setCachedCounts(
  minDate: string,
  maxDate: string,
  counts: VaccineCount[],
  possiblyTruncated: boolean
): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("acuity_poll_cache").upsert({
      range_key: rangeKey(minDate, maxDate),
      range_start: minDate,
      range_end: maxDate,
      counts,
      possibly_truncated: possiblyTruncated,
      computed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — a failed cache write just means the next request
    // re-fetches from Acuity instead of hitting a stale/absent cache.
  }
}
