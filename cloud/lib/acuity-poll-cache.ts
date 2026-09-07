import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { HourlyCount, VaccineCount } from "@/lib/acuity-client";

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
  /**
   * V-T-hourly-table addition — self-heals to [] (rather than being
   * undefined/null) both when the `hourly_counts` column value is
   * genuinely empty AND when a row was cached before this migration
   * shipped or the column doesn't exist yet (a Postgrest "unknown column"
   * error on the select falls into the existing `if (error || !data)
   * return null` branch below, same fail-soft path as no-Supabase-
   * configured — a full cache miss, not a crash) — see
   * getCachedCounts' JSDoc-style parsing below.
   */
  hourlyCounts: HourlyCount[];
  possiblyTruncated: boolean;
  computedAt: string;
};

function rangeKey(minDate: string, maxDate: string): string {
  return `${minDate}_${maxDate}`;
}

// V-T-booking-activity (Will, 2026-09-05/07): the "scheduling activity"
// table's counts are aggregated by createdDate (booking date), not
// appointment date — a completely different meaning than every other row
// in this table, which is why it gets its own key PREFIX rather than
// reusing rangeKey's bare "${minDate}_${maxDate}" (that could otherwise
// collide with, or be confused for, a real appointment-date range that
// happens to share the same two dates). See
// lib/acuity-booking-activity.ts's bookingActivityCreatedRange for how a
// caller derives minDate/maxDate here.
function activityRangeKey(minDate: string, maxDate: string): string {
  return `created_${minDate}_${maxDate}`;
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
      .select("counts, computed_at, possibly_truncated, hourly_counts")
      .eq("range_key", rangeKey(minDate, maxDate))
      .maybeSingle();

    if (error || !data) return null;

    const computedAt = new Date(data.computed_at);
    if (Number.isNaN(computedAt.getTime())) return null;
    if (Date.now() - computedAt.getTime() >= ttlSeconds * 1000) return null;

    return {
      counts: data.counts as VaccineCount[],
      // Self-heal (see CachedPoll.hourlyCounts doc comment): a row's
      // `hourly_counts` should always be at least '[]' thanks to the
      // migration's column default, but this guards against any row that
      // somehow has it as null/missing rather than trusting the DB shape.
      hourlyCounts: Array.isArray(data.hourly_counts) ? (data.hourly_counts as HourlyCount[]) : [],
      possiblyTruncated: Boolean(data.possibly_truncated),
      computedAt: data.computed_at,
    };
  } catch {
    // Supabase not configured / table missing — treat as a cache miss.
    return null;
  }
}

/**
 * `hourlyCounts` (V-T-hourly-table addition) is OPTIONAL, defaulting to
 * [] — this cache table has two other writers besides
 * app/api/acuity/poll/route.ts (app/api/ordering/recommendation/route.ts
 * and lib/acuity-future-summary.ts, both out of scope for this change),
 * which don't compute an hourly breakdown and shouldn't need to. A row
 * written by one of those callers simply has an empty hourly_counts —
 * same self-heal-to-empty behavior as a row cached before this feature
 * existed at all (see CachedPoll.hourlyCounts's doc comment) — rather than
 * this signature change forcing an unrelated caller to pass a value it has
 * no use for.
 */
export async function setCachedCounts(
  minDate: string,
  maxDate: string,
  counts: VaccineCount[],
  possiblyTruncated: boolean,
  hourlyCounts: HourlyCount[] = []
): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("acuity_poll_cache").upsert({
      range_key: rangeKey(minDate, maxDate),
      range_start: minDate,
      range_end: maxDate,
      counts,
      possibly_truncated: possiblyTruncated,
      hourly_counts: hourlyCounts,
      computed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — a failed cache write just means the next request
    // re-fetches from Acuity instead of hitting a stale/absent cache.
  }
}

export type CachedActivityPoll = {
  /** {date, vaccineName, count} where `date` is createdDate (booking
   * date) — see lib/acuity-booking-activity.ts. */
  counts: VaccineCount[];
  possiblyTruncated: boolean;
  computedAt: string;
};

/**
 * Same table, same TTL/fail-soft contract as getCachedCounts above — the
 * ONLY difference is the key (activityRangeKey's `created_` prefix) and
 * that there's no hourlyCounts to read back (the activity table has no
 * hourly breakdown of its own). See lib/acuity-booking-activity.ts's doc
 * comment for why this can't just reuse getCachedCounts/setCachedCounts
 * directly: those cache appointment-date-aggregated counts, which have
 * already discarded the one field (createdDate) this feature needs.
 */
export async function getCachedActivityCounts(
  minDate: string,
  maxDate: string,
  ttlSeconds: number
): Promise<CachedActivityPoll | null> {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("acuity_poll_cache")
      .select("counts, computed_at, possibly_truncated")
      .eq("range_key", activityRangeKey(minDate, maxDate))
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

/**
 * `hourly_counts` is written as `[]` (this feature has no hourly
 * breakdown) rather than omitted, matching every other writer of this
 * shared table — see setCachedCounts's own doc comment on why every
 * writer keeps that column populated rather than leaving it null/absent.
 */
export async function setCachedActivityCounts(
  minDate: string,
  maxDate: string,
  counts: VaccineCount[],
  possiblyTruncated: boolean
): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("acuity_poll_cache").upsert({
      range_key: activityRangeKey(minDate, maxDate),
      range_start: minDate,
      range_end: maxDate,
      counts,
      possibly_truncated: possiblyTruncated,
      hourly_counts: [],
      computed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — same fail-soft rationale as setCachedCounts above.
  }
}
