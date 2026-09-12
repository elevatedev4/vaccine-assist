import "server-only";
import { isMissingTableError } from "@/lib/schema-degradation";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import type { getSupabaseServerClient } from "@/lib/supabase/server";
import type { MatchedAdministeredRow } from "@/lib/administered/match";

/**
 * Persistence for administered (per-dose) vaccination-log data
 * (V-administered-ingest, Will 2026-09-12) — same generic `app_setting`
 * key/value table lib/inbound-attachments.ts and lib/ordering-settings.ts
 * already use (supabase/migrations/0012_app_setting.sql, confirmed
 * applied in prod), NOT a new migration (Will's brief: no prod migrations
 * from this worktree).
 *
 * One row per LOCAL (America/Chicago) calendar day:
 * `administered:<YYYY-MM-DD>` -> { date, rows, updatedAt, sources }. A
 * day's `rows` is the UNION of every dose seen for that day across every
 * ingest run, deduped by (at, itemName, occurrence) — Pioneer's daily
 * file overlaps with the previous day's, and a retained attachment can
 * be reprocessed (POST /api/administered/reprocess) more than once, so
 * re-ingesting the same dose must never double-count it.
 *
 * `occurrence` (review fix, 2026-09-12): Pioneer's "Completed date" is
 * minute-precision, so two DIFFERENT patients given the same vaccine in
 * the same minute would otherwise share an identical (at, itemName) and
 * collapse into one dose. `occurrence` is the 0-based index of a row
 * among all rows in the SAME ingest call (i.e. the same file) sharing
 * that (at, itemName), assigned in file order (see ingestAdministeredRows
 * below) — re-ingesting the SAME file, or a later file that repeats the
 * same rows in the same relative order (the normal overlap case),
 * reassigns identical occurrences so dedupe still holds, while two
 * genuine same-minute doses get distinct occurrences and both persist.
 */

export const ADMINISTERED_KEY_PREFIX = "administered:";

export function administeredDayKey(date: string): string {
  return `${ADMINISTERED_KEY_PREFIX}${date}`;
}

export type AdministeredDayRow = {
  /** UTC instant, ISO 8601 — VaccinationLogRow.completedAt / MatchedAdministeredRow.at. */
  at: string;
  itemName: string;
  vaccineId: string | null;
  /** 0-based index among rows sharing this (at, itemName) within the
   * SAME source file — see this file's top doc comment. Part of the
   * dedupe key (rowDedupeKey below), never used for anything else. */
  occurrence: number;
};

export type AdministeredDay = {
  date: string;
  rows: AdministeredDayRow[];
  updatedAt: string;
  /** Provenance: the inbound_attachment key (or, for a webhook-triggered
   * ingest whose ExtractedAttachment doesn't carry a filename, an
   * `ses:<messageId>` tag — see app/api/webhooks/ses/route.ts) each
   * contributing ingest run was sourced from. Informational only —
   * dedupe never depends on it. */
  sources: string[];
};

function rowDedupeKey(row: AdministeredDayRow): string {
  return `${row.at} ${row.itemName} ${row.occurrence}`;
}

/** Unions `existing` and `incoming`, deduped by (at, itemName, occurrence) — an
 * incoming row overwrites an existing one with the same key (harmless:
 * matching is deterministic, so a re-sent row always resolves to the
 * same vaccineId), then sorts by `at` for a stable, readable stored
 * order. */
function mergeRows(existing: AdministeredDayRow[], incoming: AdministeredDayRow[]): AdministeredDayRow[] {
  const byKey = new Map<string, AdministeredDayRow>();
  for (const row of existing) byKey.set(rowDedupeKey(row), row);
  for (const row of incoming) byKey.set(rowDedupeKey(row), row);
  return [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function mergeSources(existing: string[], sourceKey: string): string[] {
  return existing.includes(sourceKey) ? existing : [...existing, sourceKey];
}

/** Reads one day's stored administered rows, or null when nothing has
 * been ingested for that day yet OR `app_setting` doesn't exist yet
 * (degrade, same posture as lib/ordering-settings.ts's getWalkInPct).
 * Throws on any other Supabase error. */
export async function getAdministeredDay(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  date: string
): Promise<AdministeredDay | null> {
  const { data, error } = await supabase.from("app_setting").select("value").eq("key", administeredDayKey(date)).maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }

  return (data?.value as AdministeredDay | undefined) ?? null;
}

export type IngestResult = { rows: number; days: string[] };

/**
 * Groups `matchedRows` by `dateLocal` and UPSERTs each day key as the
 * union of its existing stored rows with the new ones (mergeRows above)
 * — safe to call repeatedly with overlapping data (a re-sent Pioneer
 * file, or POST /api/administered/reprocess re-parsing every retained
 * attachment) without ever double-counting a dose. `sourceKey` is
 * recorded on every day touched (see AdministeredDay.sources).
 *
 * Degrades (returns `{ rows: 0, days: [] }`, never throws) when
 * `app_setting` doesn't exist yet; throws on any other Supabase error so
 * the caller (the webhook route / the reprocess route) can catch and log
 * it per Will's brief.
 *
 * RACE (accepted for now): the read-then-write below (getAdministeredDay
 * then upsert) is not atomic, so two concurrent ingest calls touching the
 * same day key could race and one's merge could clobber the other's.
 */
export async function ingestAdministeredRows(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  matchedRows: MatchedAdministeredRow[],
  sourceKey: string
): Promise<IngestResult> {
  if (matchedRows.length === 0) return { rows: 0, days: [] };

  // occurrence: 0-based index of this row among all matchedRows (this
  // one file/ingest call) sharing the same (at, itemName), assigned in
  // the order they appear — see this file's top doc comment for why.
  const occurrenceCounts = new Map<string, number>();
  const byDate = new Map<string, AdministeredDayRow[]>();
  for (const row of matchedRows) {
    const occurrenceKey = `${row.at} ${row.itemName}`;
    const occurrence = occurrenceCounts.get(occurrenceKey) ?? 0;
    occurrenceCounts.set(occurrenceKey, occurrence + 1);

    const rows = byDate.get(row.dateLocal) ?? [];
    rows.push({ at: row.at, itemName: row.itemName, vaccineId: row.vaccineId, occurrence });
    byDate.set(row.dateLocal, rows);
  }

  const days: string[] = [];
  for (const [date, incomingRows] of byDate) {
    const existing = await getAdministeredDay(supabase, date);
    const merged: AdministeredDay = {
      date,
      rows: mergeRows(existing?.rows ?? [], incomingRows),
      updatedAt: new Date().toISOString(),
      sources: mergeSources(existing?.sources ?? [], sourceKey),
    };

    const { error } = await supabase.from("app_setting").upsert({ key: administeredDayKey(date), value: merged });
    if (error) {
      if (isMissingTableError(error)) return { rows: 0, days: [] };
      throw error;
    }
    days.push(date);
  }

  return { rows: matchedRows.length, days };
}

export type AdministeredSummary = {
  days: number;
  since: string;
  until: string;
  byVaccineId: Record<string, number>;
  byItemName: Record<string, number>;
  unmatched: number;
  total: number;
};

/**
 * The inclusive `[since, until]` window of America/Chicago calendar days
 * this summary sums, `days` entries long, ending at `until` (default:
 * today in Chicago). WINDOW DEFINITION: `until` is always included even
 * when it's today and today is still in progress — this is a rolling
 * "last N days as of right now" summary, not "N complete days", so a
 * summary pulled mid-afternoon legitimately undercounts today relative
 * to a full day. Callers wanting only complete days should pass
 * `until: addDaysToChicagoDate(todayInChicago(), -1)`.
 */
function summaryWindow(days: number, until?: string): string[] {
  const end = until ?? todayInChicago();
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    result.push(addDaysToChicagoDate(end, -i));
  }
  return result;
}

/**
 * Sums every administered dose across the last `days` Chicago calendar
 * days (see summaryWindow's window definition). A day with nothing
 * ingested yet (getAdministeredDay returns null — no email received, or
 * `app_setting` still missing) contributes zero, never throws.
 *
 * The per-day reads fire CONCURRENTLY (Promise.all) rather than one at a
 * time — review fix, Will 2026-09-12: this was `days` sequential
 * round-trips. The aggregation pass below still walks the results in
 * `window` order (not arrival order) so byVaccineId/byItemName key
 * insertion order — and therefore the JSON output — is byte-identical to
 * the old sequential version.
 */
export async function administeredSummary(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  options: { days: number; until?: string }
): Promise<AdministeredSummary> {
  const window = summaryWindow(options.days, options.until);
  const byVaccineId: Record<string, number> = {};
  const byItemName: Record<string, number> = {};
  let unmatched = 0;
  let total = 0;

  const daysData = await Promise.all(window.map((date) => getAdministeredDay(supabase, date)));

  for (const day of daysData) {
    if (!day) continue;
    for (const row of day.rows) {
      total += 1;
      byItemName[row.itemName] = (byItemName[row.itemName] ?? 0) + 1;
      if (row.vaccineId) {
        byVaccineId[row.vaccineId] = (byVaccineId[row.vaccineId] ?? 0) + 1;
      } else {
        unmatched += 1;
      }
    }
  }

  return {
    days: options.days,
    since: window[0],
    until: window[window.length - 1],
    byVaccineId,
    byItemName,
    unmatched,
    total,
  };
}
