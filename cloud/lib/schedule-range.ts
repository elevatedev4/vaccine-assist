import { addMonthsToDate, chunkDateRange } from "@/lib/appointment-explorer";
import { addDaysToChicagoDate } from "@/lib/chicago-date";
import type { HourlyCount, VaccineCount } from "@/lib/appointment-table";
import type { TestCount } from "@/lib/poc-test-table";

/**
 * Pure helpers behind the "View more" schedule page
 * (app/appointments/range/page.tsx): the default range, URL param
 * parsing/validation, the <=31-day chunking the poll route requires, and
 * merging the per-chunk poll responses back into one. Kept free of
 * React/DOM so it is unit-testable (tests/schedule-range.test.ts).
 */

/** The poll route rejects spans over this many days (MAX_RANGE_DAYS in
 * app/api/acuity/poll/route.ts) — wider ranges are fetched in chunks. */
export const POLL_MAX_RANGE_DAYS = 31;

/** Widest range the page will fetch, in calendar months from the start. */
export const MAX_RANGE_MONTHS = 6;

export type ScheduleRange = { start: string; end: string };

/** Default view: today through one calendar month out (Jan 31 -> Feb 28/29). */
export function defaultScheduleRange(today: string): ScheduleRange {
  return { start: today, end: addMonthsToDate(today, 1) };
}

/** Latest end date allowed for a given start (start + MAX_RANGE_MONTHS). */
export function maxEndForStart(start: string): string {
  return addMonthsToDate(start, MAX_RANGE_MONTHS);
}

/** Accepted year window — keeps Date.UTC's 0-99 year remapping and
 * toISOString's RangeError (years near +/-275760) unreachable. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** True for a real "YYYY-MM-DD" calendar date with a year in 2000-2100. */
export function isValidScheduleDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // Round-trip so "2026-02-31" (which Date silently rolls over) is rejected.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export type RangeValidation = { ok: true; range: ScheduleRange } | { ok: false; error: string };

/** Validates a caller-chosen start/end pair (date inputs or URL params). */
export function validateScheduleRange(start: string, end: string): RangeValidation {
  if (!isValidScheduleDate(start) || !isValidScheduleDate(end)) {
    return { ok: false, error: "Choose a valid start and end date." };
  }
  if (end < start) {
    return { ok: false, error: "The end date must be on or after the start date." };
  }
  if (end > maxEndForStart(start)) {
    return {
      ok: false,
      error: `Pick a range of ${MAX_RANGE_MONTHS} months or less (latest end date for this start: ${maxEndForStart(start)}).`,
    };
  }
  return { ok: true, range: { start, end } };
}

export type ParsedRangeParams = {
  /** The range to show: the validated URL range, or the default. */
  range: ScheduleRange;
  /** Set when URL params were present but unusable; the page shows it and falls back to `range`. */
  error: string | null;
};

/**
 * Reads ?start=&end= from the URL. Neither present -> the default
 * (today..+1 month). Present but invalid -> the default plus an error
 * message, so a bad/hand-edited link never produces a blank page.
 */
export function parseScheduleRangeParams(
  startParam: string | null,
  endParam: string | null,
  today: string
): ParsedRangeParams {
  const fallback = defaultScheduleRange(today);
  if (!startParam && !endParam) return { range: fallback, error: null };
  if (!startParam || !endParam) {
    return { range: fallback, error: "Both a start and an end date are needed." };
  }
  const result = validateScheduleRange(startParam, endParam);
  if (!result.ok) return { range: fallback, error: result.error };
  return { range: result.range, error: null };
}

/** Every "YYYY-MM-DD" day in [start, end] inclusive, ascending. */
export function daysInclusive(start: string, end: string): string[] {
  const days: string[] = [];
  let day = start;
  while (day <= end) {
    days.push(day);
    day = addDaysToChicagoDate(day, 1);
  }
  return days;
}

/** [start, end] split into contiguous chunks the poll route will accept. */
export function chunkScheduleRange(range: ScheduleRange): ScheduleRange[] {
  return chunkDateRange(range.start, range.end, POLL_MAX_RANGE_DAYS);
}

/** The slice of the poll response the schedule view needs. */
export type ChunkPollResponse = {
  configured: boolean;
  message?: string;
  settingsUrl?: string;
  counts: VaccineCount[];
  possiblyTruncated: boolean;
  cacheHit: boolean;
  asOf: string | null;
  hourlyCounts?: HourlyCount[];
  testCounts?: TestCount[];
};

export type MergedPoll = Omit<ChunkPollResponse, "hourlyCounts" | "testCounts"> & {
  hourlyCounts: HourlyCount[];
  testCounts: TestCount[];
};

/**
 * Merges per-chunk poll responses (chunks cover disjoint days, so counts
 * simply concatenate). Not configured if any chunk says so; truncated if
 * any chunk is; cached only if all are; "as of" is the OLDEST chunk
 * timestamp (the least fresh data on the page).
 */
export function mergePollResponses(parts: ChunkPollResponse[]): MergedPoll {
  const unconfigured = parts.find((part) => !part.configured);
  if (unconfigured) {
    return {
      configured: false,
      message: unconfigured.message,
      settingsUrl: unconfigured.settingsUrl,
      counts: [],
      possiblyTruncated: false,
      cacheHit: false,
      asOf: null,
      hourlyCounts: [],
      testCounts: [],
    };
  }

  const stamps = parts.map((part) => part.asOf).filter((stamp): stamp is string => !!stamp);
  stamps.sort();

  return {
    configured: true,
    counts: parts.flatMap((part) => part.counts),
    possiblyTruncated: parts.some((part) => part.possiblyTruncated),
    cacheHit: parts.length > 0 && parts.every((part) => part.cacheHit),
    asOf: stamps[0] ?? null,
    hourlyCounts: parts.flatMap((part) => part.hourlyCounts ?? []),
    testCounts: parts.flatMap((part) => part.testCounts ?? []),
  };
}

/** A merged poll tagged with the range it was fetched for. */
export type LoadedPoll = { range: ScheduleRange; poll: MergedPoll };

/**
 * The poll to render for `current`, or null while it hasn't loaded yet.
 * A poll fetched for a DIFFERENT range must never be pivoted against the
 * new range's days (it would show every row as zeros), so it is hidden
 * until the new range's data arrives. A reload of the SAME range keeps the
 * previous data visible.
 */
export function pollForRange(loaded: LoadedPoll | null, current: ScheduleRange): MergedPoll | null {
  if (!loaded) return null;
  return loaded.range.start === current.start && loaded.range.end === current.end ? loaded.poll : null;
}
