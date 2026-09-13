import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAdministeredDay } from "@/lib/administered/store";
import { addDaysToChicagoDate } from "@/lib/chicago-date";
import { deriveProductViewFields } from "@/lib/product-view";
import { buildDosesGivenPivot, resolveDoseProductName, type DosesGivenSourceDay } from "@/lib/doses-given";

// Bounds how many app_setting reads (one per day in the range — see
// lib/administered/store.ts's getAdministeredDay) one request can
// trigger, same posture as /api/administered/summary's MAX_DAYS.
const MAX_RANGE_DAYS = 366;

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** Every "YYYY-MM-DD" date from `start` to `end`, inclusive. Caller
 * guarantees start <= end and a bounded span (see MAX_RANGE_DAYS above). */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDaysToChicagoDate(current, 1);
  }
  return dates;
}

/**
 * GET /api/administered/doses-given?start=YYYY-MM-DD&end=YYYY-MM-DD —
 * day x product pivot of ingested per-dose vaccination-log data
 * (V-doses-given, Will 2026-09-12) for the "Doses given" explorer
 * (app/doses-given/page.tsx). Authed exactly like every other admin
 * route (requireAuthenticatedUser — see app/api/administered/summary/
 * route.ts). Read-only: this route only calls
 * lib/administered/store.ts's getAdministeredDay (never touches its
 * write paths) plus a plain `vaccine` catalog SELECT to resolve each
 * dose's product display name, same query app/api/administered/
 * reprocess/route.ts already runs.
 *
 * Unlike /api/administered/summary (a single rolling N-day TOTAL), this
 * route needs each day's OWN breakdown to build the pivot, so it reads
 * getAdministeredDay directly per date (in parallel, same
 * Promise.all-over-the-window shape administeredSummary itself uses)
 * rather than calling administeredSummary, which only returns the
 * already-summed total.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end || !isValidDate(start) || !isValidDate(end)) {
    return NextResponse.json({ error: "start and end must both be provided as YYYY-MM-DD." }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ error: "start must not be after end." }, { status: 400 });
  }

  const dates = dateRange(start, end);
  if (dates.length > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: `Date range must not exceed ${MAX_RANGE_DAYS} days (requested ${dates.length}).` },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseServerClient();

    const [vaccineResult, daysData] = await Promise.all([
      supabase.from("vaccine").select("id, name, ndc"),
      Promise.all(dates.map((date) => getAdministeredDay(supabase, date))),
    ]);

    if (vaccineResult.error) {
      console.error("GET /api/administered/doses-given: failed to load vaccine catalog", vaccineResult.error);
      return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
    }

    const nameByVaccineId: Record<string, string> = {};
    for (const vaccine of vaccineResult.data ?? []) {
      nameByVaccineId[vaccine.id] = deriveProductViewFields(vaccine.name, vaccine.ndc ?? null).displayName;
    }

    const days: DosesGivenSourceDay[] = dates.map((date, index) => ({
      date,
      rows: (daysData[index]?.rows ?? []).map((row) => ({ itemName: row.itemName, vaccineId: row.vaccineId })),
    }));

    const pivot = buildDosesGivenPivot(days, (row) => resolveDoseProductName(row, nameByVaccineId));

    return NextResponse.json({ start, end, ...pivot, asOf: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
