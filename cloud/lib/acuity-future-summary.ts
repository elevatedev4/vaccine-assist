import "server-only";
import {
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
  type VaccineCount,
} from "@/lib/acuity-client";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";
import { addDaysToChicagoDate } from "@/lib/chicago-date";
import { buildColumnTotals, type ColumnTotals } from "@/lib/appointment-table";

/**
 * "After today" summary (V-T9 answer, Will 2026-09-05: "add a 'total
 * vaccines remaining after today' row that sums up ALL the future
 * appointments too"). Acuity's appointments endpoint caps a single
 * request at 100 rows with NO documented offset/pagination parameter
 * (see fetchAppointmentsForRange's possiblyTruncated in
 * lib/acuity-client.ts) — a single [tomorrow, +90 days] request could
 * silently under-count if more than 100 appointments exist in that whole
 * span. Fetched instead as a series of smaller weekly WINDOWS, each one
 * safely under the 100-cap in normal volume, and each one independently
 * cache-checked/cache-written through the SAME acuity_poll_cache
 * infrastructure (lib/acuity-poll-cache.ts) the main poll route already
 * uses — a window's (start, end) pair IS its cache range_key, so this
 * reuses that table/TTL rather than inventing a second "extended blob"
 * cache, per the brief's "per-window cache reuse if feasible" steer.
 *
 * Any individual window can still (rarely) hit the 100-cap on its own —
 * possiblyTruncated is tracked PER WINDOW and surfaced as a list of the
 * affected weeks (`truncatedWindows`) rather than one blanket boolean, so
 * app/appointments/page.tsx can name which week(s) might be undercounted
 * instead of a vague "some week, somewhere" warning.
 */

// One chunk = 7 calendar days. WINDOW_COUNT * WINDOW_DAYS = 91 days beyond
// today — "out to +90 days" per the brief, rounded up to a whole number
// of 7-day windows rather than a final partial week.
export const AFTER_TODAY_WINDOW_DAYS = 7;
export const AFTER_TODAY_WINDOW_COUNT = 13;

export type AfterTodayWindow = { start: string; end: string };

/**
 * The 13 weekly windows covering [today+1, today+91] — pure, no network,
 * so it's trivially unit-testable on its own. Deliberately starts at
 * today+1 (NOT today itself): "after today" excludes today by definition
 * — today's own count is the separate "Today" summary row (see
 * computeTodayAndNext7Summaries in lib/appointment-table.ts) built from
 * the main poll's own 8-day table, not from this module at all.
 */
export function buildAfterTodayWindows(today: string): AfterTodayWindow[] {
  const windows: AfterTodayWindow[] = [];
  for (let i = 0; i < AFTER_TODAY_WINDOW_COUNT; i++) {
    const start = addDaysToChicagoDate(today, 1 + i * AFTER_TODAY_WINDOW_DAYS);
    const end = addDaysToChicagoDate(today, AFTER_TODAY_WINDOW_DAYS + i * AFTER_TODAY_WINDOW_DAYS);
    windows.push({ start, end });
  }
  return windows;
}

export type AfterTodaySummary = ColumnTotals & {
  /** "YYYY-MM-DD..YYYY-MM-DD" range strings for every window that hit the
   * 100-appointment cap — empty when nothing was truncated. */
  truncatedWindows: string[];
};

/**
 * Fetches (or reuses the cache for) every window from buildAfterTodayWindows
 * and aggregates them into one ColumnTotals — see that type's doc comment
 * in lib/appointment-table.ts for the column-alignment tradeoff a caller
 * needs to know about. `fetchAppointmentTypes` is only ever called once,
 * lazily, and only if at least one window is a cache miss — a full cache
 * hit across all 13 windows (the common case on a page auto-refresh within
 * the TTL) never touches Acuity at all.
 *
 * Throws AcuityApiError (same as fetchAppointmentsForRange/
 * fetchAppointmentTypes) on any window's network/auth/parse failure —
 * callers (app/api/acuity/poll/route.ts) catch this and degrade the
 * "After today" row rather than failing the whole poll response, since
 * the main today..+7 table is independently useful even if the heavier
 * 13-window future fetch fails.
 */
export async function fetchAfterTodaySummary(
  userId: string,
  apiKey: string,
  today: string,
  cacheSeconds: number
): Promise<AfterTodaySummary> {
  const windows = buildAfterTodayWindows(today);

  let appointmentTypeNamesPromise: Promise<Map<number, string>> | null = null;
  const getAppointmentTypeNames = (): Promise<Map<number, string>> => {
    if (!appointmentTypeNamesPromise) {
      appointmentTypeNamesPromise = fetchAppointmentTypes(userId, apiKey).then(
        (types) => new Map(types.map((t) => [t.id, t.name]))
      );
    }
    return appointmentTypeNamesPromise;
  };

  const allCounts: VaccineCount[] = [];
  const truncatedWindows: string[] = [];

  for (const { start, end } of windows) {
    const cached = await getCachedCounts(start, end, cacheSeconds);
    if (cached) {
      allCounts.push(...cached.counts);
      if (cached.possiblyTruncated) truncatedWindows.push(`${start}..${end}`);
      continue;
    }

    const nameById = await getAppointmentTypeNames();
    const { appointments, possiblyTruncated } = await fetchAppointmentsForRange(userId, apiKey, start, end);
    const counts = aggregateAppointmentCounts(appointments, nameById);
    await setCachedCounts(start, end, counts, possiblyTruncated);

    allCounts.push(...counts);
    if (possiblyTruncated) truncatedWindows.push(`${start}..${end}`);
  }

  const totals = buildColumnTotals(allCounts);
  return { ...totals, truncatedWindows };
}
