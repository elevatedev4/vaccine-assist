import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { CountableAppointment, HourlyCount, TestCount, VaccineCount } from "@/lib/acuity-client";

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

// V-T-poc-testing (Will, 2026-09-08): the point-of-care testing table's
// `testCounts` (lib/acuity-client.ts's aggregateTestCounts). The brief
// asks for this to be cached as "the same entry as counts" — but the
// `counts` column on the MAIN range_key row is a specifically-shaped
// VaccineCount[] that two OTHER modules already read directly off this
// exact cache (app/api/ordering/recommendation/route.ts and
// lib/acuity-future-summary.ts — see setCachedCounts's own doc comment);
// mixing a second, differently-shaped array into that same column would
// silently corrupt those callers' aggregation. So this reuses the
// established idiom this very file already uses for `?activity=1` and
// `?rows=1` (activityRangeKey/rowsRangeKey below) instead: the SAME
// acuity_poll_cache table, a NEW key-prefix namespace on the same generic
// jsonb `counts` column, so no migration is needed (this worktree can't
// add one — see the coordination note in the poll route's own doc
// comment). Since this is a brand-new prefix (not a reshape of an
// existing row), there's nothing to "version" — a pre-existing row using
// the bare `${minDate}_${maxDate}` key for the main counts entry is
// completely untouched by this addition.
//
// SELF-HEAL (same pattern as hourly_counts's own doc comment): the main
// counts cache and this testCounts cache are always WRITTEN together (see
// the poll route), but a request landing in the narrow window where the
// main counts cache still hits (TTL not yet expired) while this row
// happens to be missing (e.g. right after this feature's first deploy, an
// old counts row exists with no paired tests_ row yet) simply renders
// testCounts as [] for that one cache hit — it self-heals within one
// cache TTL once the main entry naturally expires and both are refetched/
// re-cached together.
function testCountsRangeKey(minDate: string, maxDate: string): string {
  return `tests_${minDate}_${maxDate}`;
}

export type CachedTestCounts = {
  testCounts: TestCount[];
  computedAt: string;
};

/** Same TTL/fail-soft contract as getCachedCounts above. */
export async function getCachedTestCounts(
  minDate: string,
  maxDate: string,
  ttlSeconds: number
): Promise<CachedTestCounts | null> {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("acuity_poll_cache")
      .select("counts, computed_at")
      .eq("range_key", testCountsRangeKey(minDate, maxDate))
      .maybeSingle();

    if (error || !data) return null;

    const computedAt = new Date(data.computed_at);
    if (Number.isNaN(computedAt.getTime())) return null;
    if (Date.now() - computedAt.getTime() >= ttlSeconds * 1000) return null;

    return {
      testCounts: Array.isArray(data.counts) ? (data.counts as TestCount[]) : [],
      computedAt: data.computed_at,
    };
  } catch {
    // Supabase not configured / table missing — treat as a cache miss.
    return null;
  }
}

/**
 * `possibly_truncated`/`hourly_counts` are written with the same
 * unconditional defaults as setCachedActivityCounts/setCachedRows above —
 * this feature doesn't track either, same "keep every writer's row shape
 * consistent" rationale.
 */
export async function setCachedTestCounts(minDate: string, maxDate: string, testCounts: TestCount[]): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("acuity_poll_cache").upsert({
      range_key: testCountsRangeKey(minDate, maxDate),
      range_start: minDate,
      range_end: maxDate,
      counts: testCounts,
      possibly_truncated: false,
      hourly_counts: [],
      computed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — same fail-soft rationale as setCachedCounts above.
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

/**
 * One de-identified appointment row for the Data Explorer
 * (app/appointments/explorer/page.tsx) — a CountableAppointment
 * (lib/acuity-client.ts's PHI-stripping boundary, unchanged) plus the
 * appointment TYPE's name, resolved once from the same appointment-types
 * map the main `?rows=1` handler already fetches for `table`/`counts` —
 * no new PHI surface, same fields the rest of this route already trusts.
 */
export type ExplorerRow = CountableAppointment & { appointmentTypeName: string };

export type CachedRows = {
  rows: ExplorerRow[];
  computedAt: string;
};

// V-data-explorer: rows mode reuses this SAME table/column (`counts` is a
// bare `jsonb` column — see 0003_acuity_poll_cache.sql — with no schema
// constraint tying it to VaccineCount's shape) under a distinct key
// PREFIX, exactly the same trick activityRangeKey uses above to avoid
// colliding with a real appointment-date range that happens to share the
// same two dates. No migration needed: a generic jsonb column holding a
// different array shape under a namespaced key is exactly what this
// column already tolerates (see getCachedActivityCounts/
// setCachedActivityCounts's own reuse of the same column/table).
function rowsRangeKey(minDate: string, maxDate: string): string {
  return `rows_${minDate}_${maxDate}`;
}

/**
 * Same TTL/fail-soft contract as getCachedCounts/getCachedActivityCounts
 * above. `hourly_counts`/`possibly_truncated` aren't read back here — the
 * Data Explorer has no hourly breakdown or truncation flag of its own
 * (see app/api/acuity/poll/route.ts's `?rows=1` doc comment).
 */
export async function getCachedRows(minDate: string, maxDate: string, ttlSeconds: number): Promise<CachedRows | null> {
  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("acuity_poll_cache")
      .select("counts, computed_at")
      .eq("range_key", rowsRangeKey(minDate, maxDate))
      .maybeSingle();

    if (error || !data) return null;

    const computedAt = new Date(data.computed_at);
    if (Number.isNaN(computedAt.getTime())) return null;
    if (Date.now() - computedAt.getTime() >= ttlSeconds * 1000) return null;

    return {
      rows: Array.isArray(data.counts) ? (data.counts as ExplorerRow[]) : [],
      computedAt: data.computed_at,
    };
  } catch {
    // Supabase not configured / table missing — treat as a cache miss.
    return null;
  }
}

/**
 * `possibly_truncated: false` and `hourly_counts: []` are written
 * unconditionally — this feature doesn't track either, same "keep every
 * writer's row shape consistent" rationale as setCachedActivityCounts
 * above (a NOT NULL column with no default-tolerant reader elsewhere).
 */
export async function setCachedRows(minDate: string, maxDate: string, rows: ExplorerRow[]): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("acuity_poll_cache").upsert({
      range_key: rowsRangeKey(minDate, maxDate),
      range_start: minDate,
      range_end: maxDate,
      counts: rows,
      possibly_truncated: false,
      hourly_counts: [],
      computed_at: new Date().toISOString(),
    });
  } catch {
    // Best-effort — same fail-soft rationale as setCachedCounts above.
  }
}
