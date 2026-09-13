import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAdministeredDay, ADMINISTERED_KEY_PREFIX } from "@/lib/administered/store";
import { isMissingTableError } from "@/lib/schema-degradation";
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
 * Cheapest possible read for the "Doses given" page's default range
 * (V-doses-given-layout, Will 2026-09-13: the page's default range
 * should start from the earliest day with any doses on file, not a
 * fixed 14-day lookback — the old fixed default is why 376 doses showed
 * instead of the 419 in his uploaded reports). A single `key`-only
 * SELECT against `app_setting`, filtered to the `administered:` prefix,
 * ordered ascending, first row only — never reads a day's `rows`
 * payload, so this stays cheap even once many months of days are
 * stored. Lives here rather than lib/administered/store.ts (this
 * worktree's brief scopes edits to this route, the page, and
 * lib/doses-given.ts only) but reuses that module's own
 * ADMINISTERED_KEY_PREFIX so the key format can't drift out of sync.
 * Returns null when nothing has been ingested yet, or `app_setting`
 * doesn't exist yet — same degrade posture as getAdministeredDay.
 */
async function getEarliestAdministeredDate(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_setting")
    .select("key")
    .like("key", `${ADMINISTERED_KEY_PREFIX}%`)
    .order("key", { ascending: true })
    .limit(1);

  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }

  const row = ((data ?? []) as { key: string }[])[0];
  return row ? row.key.slice(ADMINISTERED_KEY_PREFIX.length) : null;
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
 *
 * `?earliestOnly=1` (V-doses-given-layout) is a SEPARATE cheap path,
 * checked before start/end are even required: the page calls this once,
 * before it knows what default range to request, to find the earliest
 * ingested day (getEarliestAdministeredDate above) — no vaccine catalog
 * read, no per-day rows fetch, so it stays fast regardless of how many
 * days are on file. Every other query param is ignored on this path.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(request.url);

  if (searchParams.get("earliestOnly") === "1") {
    try {
      const supabase = getSupabaseServerClient();
      const earliestDay = await getEarliestAdministeredDate(supabase);
      return NextResponse.json({ earliestDay });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Supabase is not configured." },
        { status: 503 }
      );
    }
  }

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
