import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentials } from "@/lib/acuity-credentials";
import {
  AcuityApiError,
  aggregateAppointmentCounts,
  aggregateHourlyCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
} from "@/lib/acuity-client";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import { buildAppointmentTable, type AppointmentTable } from "@/lib/appointment-table";
import { fetchAfterTodaySummary, type AfterTodaySummary } from "@/lib/acuity-future-summary";

/**
 * Acuity Scheduling appointment-count polling (phase 2 v1, V-Q1).
 *
 * Fetches appointments for a date range (default: today through the next
 * 7 days), aggregates them to counts per appointment type per day (no
 * PHI — see lib/acuity-client.ts's CountableAppointment/PHI-stripping
 * boundary), and returns that aggregate. Results are cached ~5 min
 * (ACUITY_POLL_CACHE_SECONDS) in the acuity_poll_cache table so the
 * dashboard's refresh button and repeat polls don't hammer Acuity —
 * appointments are fetched on-demand, this is NOT a cron.
 *
 * ?start=YYYY-MM-DD&end=YYYY-MM-DD lets a caller (the /appointments
 * dashboard) request an explicit range — the dashboard computes this from
 * the pharmacy's fixed America/Chicago calendar day (lib/chicago-date.ts),
 * not the browser's own local timezone, so it stays correct even if a
 * staff device's clock/locale is set to something else. When neither
 * param is given, this route falls back to the same Chicago-day default
 * range (today .. today+7) rather than a UTC one — a UTC default used to
 * cause the "today" boundary to be off by up to 6 hours for Central time.
 *
 * ?force=1 bypasses the normal ACUITY_POLL_CACHE_SECONDS (~5 min) cache
 * read so a caller can get a just-booked appointment to show up without
 * waiting out the cache — see FORCE_COOLDOWN_SECONDS below for the much
 * shorter floor that still applies so a force request can't hammer Acuity.
 *
 * ?afterTodayOnly=1 (ROUND 4, V-T9 answer, Will 2026-09-05: "add a 'total
 * vaccines remaining after today' row that sums up all the future
 * appointments too"; reliability fix 2026-09-05 replacing an earlier
 * always-inline `?afterToday=1`) computes ONLY the `afterToday` field via
 * lib/acuity-future-summary.ts's fetchAfterTodaySummary — a 13-window
 * chunked fetch out to +90 days, well beyond MAX_RANGE_DAYS — and skips
 * every bit of the normal range/table work entirely (no `start`/`end`
 * needed, no `table`/`counts` in the response). This is DELIBERATELY a
 * separate request, not a flag added onto the normal one: 13 window
 * fetches (even with the limited concurrency fetchAfterTodaySummary now
 * uses) is heavy and more failure-prone than the main range fetch, and
 * since each window's cache key derives from "today," EVERY window is a
 * guaranteed cache miss on the first request of a new day — bundling that
 * inline with the main table risked a platform function timeout taking
 * down the whole response, including the today..+7 table that has
 * nothing to do with it. app/appointments/page.tsx now fetches the main
 * table first, renders it, and only THEN issues this as a second,
 * independent request — the table never waits on it. The desktop
 * Scheduling tab never requests this mode, so it's completely unaffected.
 * See `export const maxDuration` below, sized for this mode's worst case.
 *
 * Range spans are capped at MAX_RANGE_DAYS, checked before any
 * cache/Acuity work — an unbounded caller-supplied range (e.g.
 * ?start=0000-01-01&end=2999-12-31) would otherwise both hammer Acuity
 * with a huge query and grow the acuity_poll_cache table by one row per
 * distinct range forever (see that table's migration for the deferred
 * pruning note).
 *
 * RESPONSE CONTRACT — desktop's Scheduling tab (built in parallel,
 * cloud/README or ask the manager if this drifts) reads this route
 * directly, reusing this same ~5-min Acuity poll cache instead of
 * hitting Acuity itself. When `configured` is true, the JSON body is:
 *
 *   {
 *     configured: true,
 *     range: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *     counts: VaccineCount[],       // flat {date, vaccineName, count} list
 *     table: {
 *       days: string[],             // "YYYY-MM-DD", ascending, inclusive of range
 *       rows: Array<{ vaccineName: string, countsByDay: Record<string, number>, total: number }>,
 *       columns: Array<{ vaccineName: string, group: "COVID" | null, label: string }>,
 *       dailyTotals: Record<string, number>,
 *       grandTotal: number
 *     },
 *     possiblyTruncated: boolean,
 *     cacheHit: boolean,
 *     asOf: string,                 // ISO 8601
 *     hourlyCounts: HourlyCount[],  // ADDITIVE (V-T-hourly-table, 2026-09-05) — see below
 *   }
 *
 * `hourlyCounts` (V-T-hourly-table, Will 2026-09-05: "hourly breakdown of
 * how many vaccines are scheduled by the hour") is a purely ADDITIVE field
 * — a flat {date, hour, appointmentCount, vaccineCount}[] list (see
 * lib/acuity-client.ts's HourlyCount), independent of `table`/`counts`.
 * Existing callers (desktop's Scheduling tab) that don't know about this
 * field are completely unaffected — they simply never read it. Built by
 * aggregateHourlyCounts from the SAME already-PHI-stripped
 * `appointments` this route fetches for `counts`/`table`, so there's no
 * extra Acuity round-trip. Cached alongside `counts` in the same
 * acuity_poll_cache row (see lib/acuity-poll-cache.ts) — a row cached
 * before this shipped self-heals to `hourlyCounts: []` (the migration's
 * column default) rather than crashing or omitting the field, so a stale
 * cache hit still renders an (empty, not broken) hourly table.
 *
 * `table` is the SAME grouping the cloud dashboard renders
 * (app/appointments/page.tsx), built by lib/appointment-table.ts's
 * buildAppointmentTable from `counts` — vaccine name is now the exact
 * vaccine (e.g. "COVID-Pfizer", "Flu"), not the generic Acuity
 * appointment-type name; see lib/acuity-client.ts's
 * extractVaccineNamesFromForms / isVaccineFormFieldName for how that's
 * derived. `table.rows` and `table.columns` are index-aligned (same
 * vaccineName in the same order) — `columns` is additive header metadata
 * for a grouped header (V-T-schedule-table, Will 2026-09-04, regrouped
 * ROUND 4): COVID appointments are split by brand preference (Pfizer/
 * Moderna — ROUND 4 merges "Any" into Pfizer, see
 * lib/appointment-table.ts's resolveColumn) and age bucket
 * (3-11/12-64/65+/Unknown) into composite "COVID · {Brand} · {Age}"
 * vaccine names — see lib/acuity-client.ts's covidCompositeName/
 * deriveCovidBrand/deriveCovidAgeBucket (the composite itself is
 * UNCHANGED by the ROUND 4 merge — it still says "Any" when that's what
 * the patient answered; only the table-building layer remaps it onto the
 * Pfizer column). `counts` (the flat list) uses this same composite
 * name; `columns` is provided purely so a renderer doesn't have to
 * re-parse it. When `configured` is false (no Acuity credentials set
 * yet), the body has no `table` field — same as `counts: []`, there is
 * nothing to pivot yet.
 *
 * `?afterTodayOnly=1` RESPONSE CONTRACT (ROUND 4, a completely separate
 * shape from the one above — see the doc above for why this is its own
 * mode rather than a field bolted onto the normal response):
 *
 *   {
 *     configured: boolean,
 *     afterToday: {
 *       byColumnId: Record<string, number>,
 *       total: number,
 *       truncatedWindows: string[], // "YYYY-MM-DD..YYYY-MM-DD" per over-100-cap week
 *     } | null,                     // null if credentials aren't configured, OR the fetch itself failed
 *     afterTodayError?: string,     // present only alongside afterToday: null AND configured: true
 *   }
 *
 * `afterToday` is a ColumnTotals-shaped summary (lib/appointment-table.ts)
 * of every appointment strictly after today, out to +90ish days, keyed by
 * the SAME column ids the main `table.columns` response uses — a renderer
 * looks values up by `table.columns[i].vaccineName` the same way it
 * already reads `table.rows[i]`. See lib/acuity-future-summary.ts for the
 * chunked-fetch mechanics (including its concurrency limit) and
 * ColumnTotals's doc comment for the one documented column-alignment
 * tradeoff.
 */

// Reliability fix (2026-09-05): the `?afterTodayOnly=1` mode can run up to
// AFTER_TODAY_WINDOW_COUNT Acuity round-trips (fetchAfterTodaySummary,
// concurrency-limited but still real network I/O) on a full cache-miss
// day. Next.js/Vercel's default function timeout (10-15s on most plans)
// is comfortably enough for the normal range request but was cutting it
// close for that mode — sized generously here since this route now never
// blocks the main table on that work (see the doc above).
export const maxDuration = 60;

const MAX_RANGE_DAYS = 31;

/**
 * Floor on how often a `force=1` request is allowed to actually skip the
 * cache and hit Acuity, for a given (start, end) range — this app is a
 * single shared-login pharmacy tenant (see lib/auth.ts), so a per-range
 * cooldown reusing the existing acuity_poll_cache row IS effectively a
 * per-user limiter here: there's only ever one account's worth of
 * traffic hitting a given range key. Deliberately much shorter than
 * ACUITY_POLL_CACHE_SECONDS (5 min) so "force" is still meaningfully
 * faster than waiting out the normal cache, while a double-click or a
 * refresh-key mash can't fire more than one real Acuity call per window.
 */
const FORCE_COOLDOWN_SECONDS = 20;

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

/** Inclusive day count spanned by [start, end], both "YYYY-MM-DD". */
function rangeSpanDays(start: string, end: string): number {
  const startMs = new Date(`${start}T00:00:00Z`).getTime();
  const endMs = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

function defaultRange(): { start: string; end: string } {
  const start = todayInChicago();
  const end = addDaysToChicagoDate(start, 7);
  return { start, end };
}

/** Every "YYYY-MM-DD" day in [start, end] inclusive, ascending — the
 * column headers for the `table` field (see RESPONSE CONTRACT above). */
function daysInRange(start: string, end: string): string[] {
  const span = rangeSpanDays(start, end);
  const days: string[] = [];
  for (let i = 0; i < span; i++) days.push(addDaysToChicagoDate(start, i));
  return days;
}

/**
 * Computes the `afterToday`/`afterTodayError` response fields for the
 * `?afterTodayOnly=1` mode (ROUND 4 — see this route's doc comment
 * above). Failure-soft by design: the 13-window future fetch is heavier
 * and more failure-prone than the main range fetch — a failure here
 * degrades to `afterToday: null` + a message rather than a 502, since a
 * caller (app/appointments/page.tsx) treats this as "couldn't load the
 * after-today row" and leaves everything else on the page alone.
 */
async function resolveAfterToday(
  credentials: { userId: string; apiKey: string },
  today: string,
  cacheSeconds: number
): Promise<{ afterToday: AfterTodaySummary | null; afterTodayError?: string }> {
  try {
    const afterToday = await fetchAfterTodaySummary(credentials.userId, credentials.apiKey, today, cacheSeconds);
    return { afterToday };
  } catch (err) {
    const message = err instanceof AcuityApiError ? err.message : "Failed to compute the after-today summary.";
    console.error("GET /api/acuity/poll: after-today fetch failed", message);
    return { afterToday: null, afterTodayError: message };
  }
}

/**
 * `?afterTodayOnly=1` — see this route's doc comment for why this is a
 * fully separate, later request rather than a flag on the main one.
 * Deliberately skips start/end validation, MAX_RANGE_DAYS, and the whole
 * table/counts pipeline entirely: this mode has nothing to do with a
 * caller-supplied range, only with "today" as computed server-side.
 * `force=1` is honored here too (same FORCE_COOLDOWN_SECONDS floor as the
 * main mode) so a manual refresh can bypass this summary's cache as well.
 */
async function handleAfterTodayOnly(requestUrl: URL): Promise<Response> {
  const credentials = await getAcuityCredentials();
  if (!credentials) {
    return NextResponse.json({ configured: false, afterToday: null });
  }

  const force = requestUrl.searchParams.get("force") === "1";
  const cacheSeconds = force ? FORCE_COOLDOWN_SECONDS : env.acuityPollCacheSeconds();

  const { afterToday, afterTodayError } = await resolveAfterToday(credentials, todayInChicago(), cacheSeconds);
  return NextResponse.json({ configured: true, afterToday, afterTodayError });
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const requestUrl = new URL(request.url);

  if (requestUrl.searchParams.get("afterTodayOnly") === "1") {
    return handleAfterTodayOnly(requestUrl);
  }

  const startParam = requestUrl.searchParams.get("start");
  const endParam = requestUrl.searchParams.get("end");

  let start: string;
  let end: string;
  if (startParam || endParam) {
    if (!startParam || !endParam || !isValidDate(startParam) || !isValidDate(endParam)) {
      return NextResponse.json(
        { error: "start and end must both be provided as YYYY-MM-DD." },
        { status: 400 }
      );
    }
    start = startParam;
    end = endParam;
  } else {
    const defaults = defaultRange();
    start = defaults.start;
    end = defaults.end;
  }

  if (start > end) {
    return NextResponse.json({ error: "start must not be after end." }, { status: 400 });
  }

  const spanDays = rangeSpanDays(start, end);
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Date range must not exceed ${MAX_RANGE_DAYS} days (requested ${spanDays}).` },
      { status: 400 }
    );
  }

  const cacheSeconds = env.acuityPollCacheSeconds();
  const force = requestUrl.searchParams.get("force") === "1";
  // A forced request still respects FORCE_COOLDOWN_SECONDS instead of the
  // normal (longer) cache TTL — see that constant's comment.
  const effectiveCacheSeconds = force ? FORCE_COOLDOWN_SECONDS : cacheSeconds;

  const credentials = await getAcuityCredentials();
  if (!credentials) {
    return NextResponse.json({
      configured: false,
      message:
        "Acuity credentials are not configured yet. Set them in Settings before polling appointment counts.",
      settingsUrl: "/settings",
      range: { start, end },
      counts: [],
      possiblyTruncated: false,
      cacheHit: false,
      asOf: null,
      hourlyCounts: [],
    });
  }

  const days = daysInRange(start, end);

  const cached = await getCachedCounts(start, end, effectiveCacheSeconds);
  if (cached) {
    return NextResponse.json({
      configured: true,
      range: { start, end },
      counts: cached.counts,
      table: buildAppointmentTable(cached.counts, days),
      possiblyTruncated: cached.possiblyTruncated,
      cacheHit: true,
      asOf: cached.computedAt,
      hourlyCounts: cached.hourlyCounts,
    });
  }

  try {
    const [appointmentTypes, { appointments, possiblyTruncated }] = await Promise.all([
      fetchAppointmentTypes(credentials.userId, credentials.apiKey),
      fetchAppointmentsForRange(credentials.userId, credentials.apiKey, start, end),
    ]);

    const nameById = new Map(appointmentTypes.map((type) => [type.id, type.name]));
    const counts = aggregateAppointmentCounts(appointments, nameById);
    const table: AppointmentTable = buildAppointmentTable(counts, days);
    const hourlyCounts = aggregateHourlyCounts(appointments);
    const asOf = new Date().toISOString();

    await setCachedCounts(start, end, counts, possiblyTruncated, hourlyCounts);

    return NextResponse.json({
      configured: true,
      range: { start, end },
      counts,
      table,
      possiblyTruncated,
      cacheHit: false,
      asOf,
      hourlyCounts,
    });
  } catch (err) {
    const message = err instanceof AcuityApiError ? err.message : "Failed to poll Acuity for appointments.";
    console.error("GET /api/acuity/poll: Acuity fetch failed", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
