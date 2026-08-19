import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentials } from "@/lib/acuity-credentials";
import {
  AcuityApiError,
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
} from "@/lib/acuity-client";
import { getCachedCounts, setCachedCounts } from "@/lib/acuity-poll-cache";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import { buildAppointmentTable, type AppointmentTable } from "@/lib/appointment-table";

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
 *       dailyTotals: Record<string, number>,
 *       grandTotal: number
 *     },
 *     possiblyTruncated: boolean,
 *     cacheHit: boolean,
 *     asOf: string,                 // ISO 8601
 *   }
 *
 * `table` is the SAME grouping the cloud dashboard renders
 * (app/appointments/page.tsx), built by lib/appointment-table.ts's
 * buildAppointmentTable from `counts` — vaccine name is now the exact
 * vaccine (e.g. "COVID-Pfizer", "Flu"), not the generic Acuity
 * appointment-type name; see lib/acuity-client.ts's
 * extractVaccineNamesFromForms / isVaccineFormFieldName for how that's
 * derived. When `configured` is false (no Acuity credentials set yet),
 * the body has no `table` field — same as `counts: []`, there is nothing
 * to pivot yet.
 */

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

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const requestUrl = new URL(request.url);
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
    const asOf = new Date().toISOString();

    await setCachedCounts(start, end, counts, possiblyTruncated);

    return NextResponse.json({
      configured: true,
      range: { start, end },
      counts,
      table,
      possiblyTruncated,
      cacheHit: false,
      asOf,
    });
  } catch (err) {
    const message = err instanceof AcuityApiError ? err.message : "Failed to poll Acuity for appointments.";
    console.error("GET /api/acuity/poll: Acuity fetch failed", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
