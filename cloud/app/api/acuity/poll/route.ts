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
 * dashboard) request an explicit range computed from the browser's local
 * "today" — the server has no reliable notion of the pharmacy's local
 * day, so it only falls back to a UTC-based default when neither param
 * is given.
 *
 * Range spans are capped at MAX_RANGE_DAYS, checked before any
 * cache/Acuity work — an unbounded caller-supplied range (e.g.
 * ?start=0000-01-01&end=2999-12-31) would otherwise both hammer Acuity
 * with a huge query and grow the acuity_poll_cache table by one row per
 * distinct range forever (see that table's migration for the deferred
 * pruning note).
 */

const MAX_RANGE_DAYS = 31;

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
  const now = new Date();
  const start = now.toISOString().slice(0, 10);
  const endDate = new Date(now);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
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

  const cached = await getCachedCounts(start, end, cacheSeconds);
  if (cached) {
    return NextResponse.json({
      configured: true,
      range: { start, end },
      counts: cached.counts,
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
    const asOf = new Date().toISOString();

    await setCachedCounts(start, end, counts, possiblyTruncated);

    return NextResponse.json({
      configured: true,
      range: { start, end },
      counts,
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
