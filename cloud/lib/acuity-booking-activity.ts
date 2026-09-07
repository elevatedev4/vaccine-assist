import "server-only";
import {
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
  type CountableAppointment,
  type VaccineCount,
} from "@/lib/acuity-client";
import { addDaysToChicagoDate } from "@/lib/chicago-date";
import { BOOKING_ACTIVITY_LOOKBACK_DAYS } from "@/lib/appointment-table";

/**
 * "Scheduling activity" data layer (V-T-booking-activity, Will
 * 2026-09-05/07, verbatim): a THIRD table on /appointments tracking
 * MARKETING, not the schedule — "# vaccines BOOKED per day (the day the
 * booking was MADE, not the appointment date) for the last 28 days."
 *
 * A booking made in the last BOOKING_ACTIVITY_LOOKBACK_DAYS days can be
 * FOR an appointment anywhere from the recent past out to ~13 weeks in the
 * future (a patient booking today for a flu shot 3 months out is exactly
 * the kind of booking this feature exists to surface) — so unlike the main
 * table (which fetches by a narrow APPOINTMENT-date range), this fetches a
 * wide [today - LOOKBACK_DAYS, today + FUTURE_DAYS] window by
 * APPOINTMENT date, then filters by each appointment's own `createdDate`
 * (see lib/acuity-client.ts's CountableAppointment.createdDate) after the
 * fact. That's ~134 days of appointments — comfortably past Acuity's
 * 100-per-request cap (see fetchAppointmentsForRange's possiblyTruncated)
 * — so it's fetched the SAME chunked/limited-concurrency way
 * lib/acuity-future-summary.ts fetches its own wide "after today" range:
 * a series of WINDOW_DAYS-day windows, at most FETCH_CONCURRENCY in
 * flight at once.
 *
 * DELIBERATELY NOT reusing lib/acuity-future-summary.ts's per-window
 * acuity_poll_cache reuse: that cache stores VaccineCount[] AGGREGATED BY
 * APPOINTMENT DATE, which has already thrown away the one field
 * (createdDate) this feature needs — a cache hit there would silently
 * produce zero activity data. Callers instead cache the FINAL, already
 * createdDate-aggregated result under its own single key (see
 * lib/acuity-poll-cache.ts's getCachedActivityCounts/setCachedActivityCounts,
 * keyed `created_${min}_${max}`) — this module only ever talks to Acuity,
 * never to the cache.
 */

// One chunk = 7 calendar days, same size as acuity-future-summary.ts's
// AFTER_TODAY_WINDOW_DAYS — comfortably under the 100-appointment cap for
// this single-pharmacy prototype's normal volume.
export const BOOKING_ACTIVITY_FETCH_WINDOW_DAYS = 7;

// How far into the future an appointment booked recently might be
// scheduled — "13 weeks" per the brief, so a booking made yesterday for a
// flu shot 3 months from now is still counted as yesterday's activity.
export const BOOKING_ACTIVITY_FUTURE_DAYS = 13 * 7;

// Bounded concurrency, same rationale/value as
// acuity-future-summary.ts's AFTER_TODAY_FETCH_CONCURRENCY — several
// dozen windows on a full cache-miss day would otherwise fire everything
// at once with no documented Acuity rate limit to lean on.
export const BOOKING_ACTIVITY_FETCH_CONCURRENCY = 4;

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight at
 * once, preserving each result at its original index. Deliberately a
 * separate copy of the identical helper in lib/acuity-future-summary.ts
 * rather than a shared import — both modules are small, independently
 * tested, and this avoids coupling this feature's fetch shape to that
 * module's (different) caching behavior for what's a ~15-line utility.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export type BookingActivityFetchWindow = { start: string; end: string };

function minDateStr(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * The APPOINTMENT-date windows to fetch, covering
 * [today - BOOKING_ACTIVITY_LOOKBACK_DAYS, today + BOOKING_ACTIVITY_FUTURE_DAYS]
 * in BOOKING_ACTIVITY_FETCH_WINDOW_DAYS-day chunks — pure, no network, so
 * it's trivially unit-testable on its own (same pattern as
 * buildAfterTodayWindows in lib/acuity-future-summary.ts). The final
 * window is clipped rather than overshooting the range end, since the
 * total span isn't guaranteed to be a whole multiple of the window size.
 */
export function buildBookingActivityFetchWindows(today: string): BookingActivityFetchWindow[] {
  const rangeStart = addDaysToChicagoDate(today, -BOOKING_ACTIVITY_LOOKBACK_DAYS);
  const rangeEnd = addDaysToChicagoDate(today, BOOKING_ACTIVITY_FUTURE_DAYS);

  const windows: BookingActivityFetchWindow[] = [];
  let cursor = rangeStart;
  while (cursor <= rangeEnd) {
    const windowEnd = minDateStr(addDaysToChicagoDate(cursor, BOOKING_ACTIVITY_FETCH_WINDOW_DAYS - 1), rangeEnd);
    windows.push({ start: cursor, end: windowEnd });
    cursor = addDaysToChicagoDate(windowEnd, 1);
  }
  return windows;
}

/**
 * The [minCreated, maxCreated] createdDate window every booking must fall
 * within to count as "activity" — the last BOOKING_ACTIVITY_LOOKBACK_DAYS
 * days up through today, inclusive. Exported so
 * app/api/acuity/poll/route.ts can build the SAME `created_${min}_${max}`
 * cache key this module's result gets cached under (see
 * lib/acuity-poll-cache.ts) without duplicating this date math.
 */
export function bookingActivityCreatedRange(today: string): { minCreated: string; maxCreated: string } {
  return { minCreated: addDaysToChicagoDate(today, -BOOKING_ACTIVITY_LOOKBACK_DAYS), maxCreated: today };
}

/**
 * Re-keys already-PHI-stripped appointments onto their OWN createdDate
 * (dropping `date`, the appointment day, entirely) and filters out any
 * whose createdDate falls outside [minCreated, maxCreated] — including
 * the "" fail-soft sentinel for a missing/unparseable datetimeCreated
 * (see CountableAppointment.createdDate's doc comment), since "" never
 * falls inside a real YYYY-MM-DD range. Remapping onto the SAME `date`
 * field aggregateAppointmentCounts already reads means every COVID/Flu
 * composite-naming and vaccine-name-fallback rule in that function
 * applies here unchanged — no duplicated logic.
 */
function remapToCreatedDate(
  appointments: CountableAppointment[],
  minCreated: string,
  maxCreated: string
): CountableAppointment[] {
  return appointments
    .filter((a) => a.createdDate >= minCreated && a.createdDate <= maxCreated)
    .map((a) => ({ ...a, date: a.createdDate }));
}

export type BookingActivityFetchResult = {
  /** {date, vaccineName, count} where `date` is the booking's createdDate
   * — see remapToCreatedDate above. */
  counts: VaccineCount[];
  /** "YYYY-MM-DD..YYYY-MM-DD" per appointment-date window that hit the
   * 100-appointment cap — same shape as
   * lib/acuity-future-summary.ts's AfterTodaySummary.truncatedWindows. */
  truncatedWindows: string[];
};

/**
 * Fetches every appointment-date window from buildBookingActivityFetchWindows,
 * re-keys the results onto createdDate (remapToCreatedDate), and aggregates
 * them into the {date, vaccineName, count} shape app/api/acuity/poll/route.ts
 * caches and app/appointments/page.tsx's buildBookingActivityTable consumes.
 * `fetchAppointmentTypes` is fetched once, unconditionally, alongside the
 * windows (rather than lazily-on-first-miss like acuity-future-summary.ts) —
 * simpler and just as cheap, since this whole path only ever runs on a
 * cache miss of the SINGLE top-level activity cache key (see this module's
 * doc comment on why per-window caching doesn't apply here).
 *
 * Throws AcuityApiError (same as fetchAppointmentsForRange/
 * fetchAppointmentTypes) on any window's network/auth/parse failure —
 * app/api/acuity/poll/route.ts's `?activity=1` handler catches this and
 * degrades the scheduling-activity table rather than failing the whole
 * poll route.
 */
export async function fetchBookingActivityCounts(
  userId: string,
  apiKey: string,
  today: string
): Promise<BookingActivityFetchResult> {
  const { minCreated, maxCreated } = bookingActivityCreatedRange(today);
  const windows = buildBookingActivityFetchWindows(today);

  const [nameById, windowResults] = await Promise.all([
    fetchAppointmentTypes(userId, apiKey).then((types) => new Map(types.map((t) => [t.id, t.name]))),
    mapWithConcurrency(windows, BOOKING_ACTIVITY_FETCH_CONCURRENCY, async ({ start, end }) => {
      const { appointments, possiblyTruncated } = await fetchAppointmentsForRange(userId, apiKey, start, end);
      return { appointments, possiblyTruncated, rangeKey: `${start}..${end}` };
    }),
  ]);

  const allAppointments: CountableAppointment[] = [];
  const truncatedWindows: string[] = [];
  for (const result of windowResults) {
    allAppointments.push(...result.appointments);
    if (result.possiblyTruncated) truncatedWindows.push(result.rangeKey);
  }

  const activityAppointments = remapToCreatedDate(allAppointments, minCreated, maxCreated);
  const counts = aggregateAppointmentCounts(activityAppointments, nameById);

  return { counts, truncatedWindows };
}
