/**
 * Pure, client-safe logic for the Data Explorer
 * (app/appointments/explorer/page.tsx) — filtering, searching, sorting,
 * sums, grouping, and CSV serialization over one-row-per-appointment
 * data. Deliberately has NO "server-only" import and no dependency on
 * lib/acuity-client.ts (which IS server-only) — same "re-declare the
 * client-safe shape locally" convention lib/appointment-table.ts already
 * uses for VaccineCount/HourlyCount (see that file's doc comment on
 * HourlyCount) — so this file can be imported directly from the client
 * page and unit-tested with plain objects, no server mocking required.
 *
 * ExplorerRow's fields are exactly lib/acuity-client.ts's
 * CountableAppointment fields plus `appointmentTypeName` — see that
 * type's PHI-boundary doc comment for what's guaranteed to NEVER appear
 * here (name/email/phone/notes/raw age/DOB/etc). Every function below
 * only ever reads these fields.
 */

export type CovidBrand = "pfizer" | "moderna" | "any";
export type CovidAgeBucket = "3-11" | "12-64" | "65+" | "unknown";
export type FluAgeBucket = "3-64" | "65+" | "unknown";

export type ExplorerRow = {
  /** "YYYY-MM-DD", America/Chicago — the appointment's own calendar day. */
  date: string;
  /** "YYYY-MM-DD", America/Chicago — the day the booking was MADE. "" if
   * unparseable/missing (same fail-soft sentinel as acuity-client.ts). */
  createdDate: string;
  appointmentTypeId: number;
  appointmentTypeName: string;
  vaccineNames: string[];
  /** Point-of-care test name(s) on this appointment, e.g. ["COVID"] —
   * empty for a normal vaccine appointment. Same field the main dashboard's
   * point-of-care testing table reads (lib/poc-test-table.ts's TestCount),
   * added here (V-data-explorer follow-up, Will 2026-09-08) so a POC
   * testing appointment's test(s) show up in the explorer too. */
  testNames: string[];
  covidBrand: CovidBrand;
  covidAgeBucket: CovidAgeBucket;
  fluAgeBucket: FluAgeBucket;
  /** 0-23, America/Chicago. */
  hourOfDay: number;
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Parses a "YYYY-MM-DD" string as a UTC-noon-anchored Date — same
 * DST-proof approach lib/chicago-date.ts uses for pure calendar-date
 * arithmetic (never a local-timezone parse, which would drift a day
 * depending on the runtime's own zone). Returns null for anything that
 * isn't exactly "YYYY-MM-DD" with valid components. */
function parseCalendarDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** "Sun".."Sat" for a "YYYY-MM-DD" date string. Falls back to "" for an
 * unparseable date rather than throwing — a defensive case that never
 * happens for a row that survived acuity-client.ts's own date filter. */
export function dayOfWeekLabel(dateStr: string): string {
  const date = parseCalendarDate(dateStr);
  return date ? DAY_LABELS[date.getUTCDay()] : "";
}

/** "10 AM" / "12 PM" / "12 AM" — 12-hour, no minutes (every appointment
 * bucket is a whole hour), deliberately a different label format than the
 * main dashboard's "10:00" (lib/appointment-table.ts/app/appointments/
 * page.tsx) per the explorer's own spec ("Hour (e.g. '10 AM')"). Returns
 * "—" for the -1 out-of-range sentinel (see acuity-client.ts's
 * acuityDatetimeToChicagoHour) or any other out-of-[0,23] value. */
export function formatHourLabel(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "—";
  const period = hour < 12 ? "AM" : "PM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour} ${period}`;
}

/**
 * Whole days between a row's booking date (createdDate) and its
 * appointment date (date) — positive when booked ahead of the visit,
 * negative for a same-day-or-later booking anomaly, null when either date
 * is missing/unparseable (an empty createdDate, in particular, is a real,
 * expected case per acuity-client.ts's fail-soft sentinel — not an
 * error). Pure calendar-date subtraction (UTC-noon anchors), never
 * affected by DST.
 */
export function computeLeadDays(row: ExplorerRow): number | null {
  const created = parseCalendarDate(row.createdDate);
  const appt = parseCalendarDate(row.date);
  if (!created || !appt) return null;
  return Math.round((appt.getTime() - created.getTime()) / 86_400_000);
}

/**
 * Case-insensitive substring match against every free-text-searchable
 * facet of a row: both dates, day-of-week and hour labels, appointment
 * type name, the joined vaccine list, and every bucket value. Blank/
 * whitespace-only query matches everything (the explorer's default,
 * unfiltered state).
 */
export function matchesSearch(row: ExplorerRow, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;

  const haystack = [
    row.date,
    row.createdDate,
    dayOfWeekLabel(row.date),
    formatHourLabel(row.hourOfDay),
    row.appointmentTypeName,
    row.vaccineNames.join(", "),
    row.testNames.join(", "),
    row.covidBrand,
    row.covidAgeBucket,
    row.fluAgeBucket,
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(trimmed);
}

/**
 * Per-column filter state for the explorer table. Text columns
 * (apptDateText/bookedOnText/leadDaysText/vaccineCountText) are
 * case-insensitive substring matches against the column's DISPLAYED
 * value (so e.g. filtering leadDaysText:"-" finds every negative lead
 * time). Enumerated columns (day/hour/appointmentType/vaccine/
 * covidBrand/covidAge/fluAge) are multi-select allowlists — an empty
 * array means "no filter" for that column, matching every row.
 */
export type ExplorerFilters = {
  search: string;
  apptDateText: string;
  bookedOnText: string;
  leadDaysText: string;
  vaccineCountText: string;
  day: string[];
  hour: string[];
  appointmentType: string[];
  vaccine: string[];
  /** Multi-select allowlist over `testNames` — same "matches if ANY
   * selected name is on the row" semantics as `vaccine` above. */
  tests: string[];
  covidBrand: string[];
  covidAge: string[];
  fluAge: string[];
};

export const EMPTY_EXPLORER_FILTERS: ExplorerFilters = {
  search: "",
  apptDateText: "",
  bookedOnText: "",
  leadDaysText: "",
  vaccineCountText: "",
  day: [],
  hour: [],
  appointmentType: [],
  vaccine: [],
  tests: [],
  covidBrand: [],
  covidAge: [],
  fluAge: [],
};

/** Applies `filters.search` plus every per-column filter — a row must
 * pass ALL of them (AND, not OR) to remain in the result. */
export function applyFilters(rows: ExplorerRow[], filters: ExplorerFilters): ExplorerRow[] {
  return rows.filter((row) => {
    if (!matchesSearch(row, filters.search)) return false;

    if (filters.apptDateText.trim() && !row.date.toLowerCase().includes(filters.apptDateText.trim().toLowerCase())) {
      return false;
    }
    if (
      filters.bookedOnText.trim() &&
      !row.createdDate.toLowerCase().includes(filters.bookedOnText.trim().toLowerCase())
    ) {
      return false;
    }
    if (filters.leadDaysText.trim()) {
      const lead = computeLeadDays(row);
      const leadDisplay = lead === null ? "" : String(lead);
      if (!leadDisplay.includes(filters.leadDaysText.trim())) return false;
    }
    if (filters.vaccineCountText.trim() && !String(row.vaccineNames.length).includes(filters.vaccineCountText.trim())) {
      return false;
    }

    if (filters.day.length > 0 && !filters.day.includes(dayOfWeekLabel(row.date))) return false;
    if (filters.hour.length > 0 && !filters.hour.includes(formatHourLabel(row.hourOfDay))) return false;
    if (filters.appointmentType.length > 0 && !filters.appointmentType.includes(row.appointmentTypeName)) return false;
    if (filters.vaccine.length > 0 && !row.vaccineNames.some((name) => filters.vaccine.includes(name))) return false;
    if (filters.tests.length > 0 && !row.testNames.some((name) => filters.tests.includes(name))) return false;
    if (filters.covidBrand.length > 0 && !filters.covidBrand.includes(row.covidBrand)) return false;
    if (filters.covidAge.length > 0 && !filters.covidAge.includes(row.covidAgeBucket)) return false;
    if (filters.fluAge.length > 0 && !filters.fluAge.includes(row.fluAgeBucket)) return false;

    return true;
  });
}

/**
 * True for a point-of-care TEST appointment with no vaccine component
 * (testNames non-empty, vaccineNames empty) — Will's "on tests" (V-T-
 * explorer round 4, verbatim: "On tests, vaccine related fields should be
 * blank, not have unknown or any written in there"). A MIXED appointment
 * (both vaccineNames and testNames populated, if the intake model ever
 * allows it) is deliberately NOT treated as a test appointment here: it
 * genuinely has vaccine data, so that data stays visible — see
 * vaccineCellValues below, whose own doc comment covers the "mixed"
 * case explicitly.
 */
export function isTestOnlyAppointment(row: Pick<ExplorerRow, "vaccineNames" | "testNames">): boolean {
  return row.testNames.length > 0 && row.vaccineNames.length === 0;
}

/** The explorer table's vaccine-related cells, already formatted for
 * display — same 4 values app/appointments/explorer/page.tsx's
 * renderDataRow previously read straight off `row` (vaccineNames joined,
 * covidBrand, covidAgeBucket, fluAgeBucket). */
export type VaccineCellValues = {
  vaccineNamesDisplay: string;
  covidBrand: string;
  covidAgeBucket: string;
  fluAgeBucket: string;
};

/**
 * Single source of truth for what the explorer's vaccine-related cells
 * show — used by both the flat table and every group-by table (all of
 * them render through the same renderDataRow in the page, so a grouped
 * "Test" table stays consistent with the flat one automatically).
 *
 * A test-only appointment (isTestOnlyAppointment) has no real vaccine to
 * report — covidBrand/covidAgeBucket/fluAgeBucket on a row like that are
 * just the acuity-client.ts default buckets ("any"/"unknown"/"unknown")
 * for a form question the patient was never actually asked, not a
 * meaningful "no preference" or "age unknown" answer — so every one of
 * these cells renders as an EMPTY STRING rather than that placeholder
 * text (Will, verbatim: "vaccine related fields should be blank, not have
 * unknown or any written in there").
 *
 * Any other row (a vaccine appointment, or a MIXED vaccine+test
 * appointment) is unchanged from the table's pre-existing formatting:
 * vaccineNames joined with ", " (or "—" when genuinely empty on a
 * non-test row), and covidBrand/covidAgeBucket/fluAgeBucket exactly as
 * derived.
 */
export function vaccineCellValues(row: ExplorerRow): VaccineCellValues {
  if (isTestOnlyAppointment(row)) {
    return { vaccineNamesDisplay: "", covidBrand: "", covidAgeBucket: "", fluAgeBucket: "" };
  }
  return {
    vaccineNamesDisplay: row.vaccineNames.join(", ") || "—",
    covidBrand: row.covidBrand,
    covidAgeBucket: row.covidAgeBucket,
    fluAgeBucket: row.fluAgeBucket,
  };
}

export type SortKey =
  | "date"
  | "day"
  | "hour"
  | "createdDate"
  | "leadDays"
  | "appointmentTypeName"
  | "vaccineNames"
  | "testNames"
  | "vaccineCount"
  | "covidBrand"
  | "covidAgeBucket"
  | "fluAgeBucket";

export type SortDirection = "asc" | "desc";

function sortValue(row: ExplorerRow, key: SortKey): string | number {
  switch (key) {
    case "date":
      return row.date;
    case "day":
      return dayOfWeekLabel(row.date);
    case "hour":
      return row.hourOfDay;
    case "createdDate":
      return row.createdDate;
    case "leadDays":
      // Missing lead days (no parseable createdDate) sort last in
      // ascending order, first in descending — Number.NEGATIVE_INFINITY
      // achieves that without a separate "null last" branch, since sort
      // direction is applied by reversing the whole array below.
      return computeLeadDays(row) ?? Number.NEGATIVE_INFINITY;
    case "appointmentTypeName":
      return row.appointmentTypeName;
    case "vaccineNames":
      return row.vaccineNames.join(", ");
    case "testNames":
      return row.testNames.join(", ");
    case "vaccineCount":
      return row.vaccineNames.length;
    case "covidBrand":
      return row.covidBrand;
    case "covidAgeBucket":
      return row.covidAgeBucket;
    case "fluAgeBucket":
      return row.fluAgeBucket;
    default:
      return "";
  }
}

/** Stable sort (Array.prototype.sort is stable per spec) by a single
 * column, ascending or descending. Never mutates `rows`. */
export function sortRows(rows: ExplorerRow[], key: SortKey, direction: SortDirection): ExplorerRow[] {
  const sorted = [...rows].sort((a, b) => {
    const aValue = sortValue(a, key);
    const bValue = sortValue(b, key);
    if (typeof aValue === "number" && typeof bValue === "number") return aValue - bValue;
    return String(aValue).localeCompare(String(bValue));
  });
  return direction === "asc" ? sorted : sorted.reverse();
}

export type ExplorerSums = {
  appointments: number;
  vaccines: number;
  avgVaccinesPerAppointment: number;
  /** null when no row in the set has a computable lead time (e.g. an
   * empty result set, or every row missing createdDate). */
  avgLeadDays: number | null;
};

/**
 * Live totals over the CURRENT filtered set — appointments is a plain row
 * count; vaccines sums each row's vaccineNames.length (an appointment
 * with 2 vaccines contributes 2, one with 0 contributes 0 — no
 * appointment-type-name fallback here, unlike
 * lib/acuity-client.ts's aggregateHourlyCounts, since the explorer's own
 * "# vaccines" column is exactly vaccineNames.length and these sums must
 * match what's on screen). avgLeadDays averages only the rows with a
 * computable lead time (see computeLeadDays) — a row with no parseable
 * createdDate is excluded from that average rather than treated as 0.
 */
export function computeSums(rows: ExplorerRow[]): ExplorerSums {
  const appointments = rows.length;
  const vaccines = rows.reduce((sum, row) => sum + row.vaccineNames.length, 0);
  const avgVaccinesPerAppointment = appointments === 0 ? 0 : vaccines / appointments;

  const leadDaysValues = rows.map(computeLeadDays).filter((value): value is number => value !== null);
  const avgLeadDays =
    leadDaysValues.length === 0 ? null : leadDaysValues.reduce((sum, value) => sum + value, 0) / leadDaysValues.length;

  return { appointments, vaccines, avgVaccinesPerAppointment, avgLeadDays };
}

export type GroupByMode =
  | "none"
  | "apptDate"
  | "bookedOn"
  | "day"
  | "hour"
  | "vaccine"
  | "test"
  | "appointmentType"
  | "covidBrand"
  | "covidAge"
  | "fluAge";

/**
 * One group-by bucket, carrying its own full ExplorerRow list (V-T27,
 * Will 2026-09-09 verbatim: "Group by should make groups and display the
 * data in a table under each group. The current functionality is
 * summing." — replaces the old count-only GroupSummaryRow/computeGroups
 * pair). `rows` is UNSORTED here — same "options describe the loaded
 * range" convention as filterOptions in the page: the caller sorts each
 * group's own rows (sortRows) with whatever column sort is currently
 * active, exactly like the ungrouped table does, so a grouped view is
 * never out of sync with the flat one.
 */
export type ExplorerRowGroup = {
  group: string;
  rows: ExplorerRow[];
};

// Buckets used to put "day" groups in calendar-week order (Sun..Sat)
// rather than alphabetical (which would wrongly sort "Fri" before "Mon").
const DAY_ORDER_FOR_GROUPS: readonly string[] = DAY_LABELS;

/**
 * Sort key for one group, per mode — backs the "sensible order" rule in
 * groupRows's doc comment: date-keyed modes sort chronologically (a plain
 * ascending string compare already achieves that, since every date group
 * key is "YYYY-MM-DD" and the "Unknown" fallback bucket, used only when a
 * row's date/createdDate is unparseable, sorts after every real date —
 * digits precede "U" in ASCII); "day" sorts calendar-week order via
 * DAY_ORDER_FOR_GROUPS (its own "Unknown" fallback sorts last); "hour"
 * sorts by the underlying 0-23 hour value rather than its "9 AM"/"1 PM"
 * label (every row in an hour group shares the same hourOfDay by
 * construction, so reading it off the first row is exact, not a
 * heuristic); every other mode (vaccine/test/appointmentType/
 * covidBrand/covidAge/fluAge) sorts alphabetically by group label.
 */
function groupSortKey(mode: GroupByMode, group: string, rows: ExplorerRow[]): string | number {
  if (mode === "day") {
    const index = DAY_ORDER_FOR_GROUPS.indexOf(group);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }
  if (mode === "hour") {
    return rows[0]?.hourOfDay ?? 0;
  }
  return group;
}

function compareGroups(a: ExplorerRowGroup, b: ExplorerRowGroup, mode: GroupByMode): number {
  const keyA = groupSortKey(mode, a.group, a.rows);
  const keyB = groupSortKey(mode, b.group, b.rows);
  if (typeof keyA === "number" && typeof keyB === "number") return keyA - keyB;
  return String(keyA).localeCompare(String(keyB));
}

/**
 * Buckets the filtered rows by `mode`, keeping every member row (not just
 * a count) in each bucket — "none" returns [] (no grouped tables to
 * render; the page falls back to its single flat table).
 *
 * "vaccine" and "test" modes are the deliberately double-membership
 * buckets (per the explorer's spec, unchanged from the old
 * count-only computeGroups): a row with 2 vaccineNames (or 2 testNames)
 * appears once under EACH name's group — an appointment showing up under
 * two different vaccine/test groups is not a bug, it's Will's own
 * "Rows that belong to multiple groups ... appear under each" spec
 * (V-T27). A row with NO vaccineNames/testNames in that mode is EXCLUDED
 * entirely — no "(none)" bucket (V-T28, Will 2026-09-09 verbatim: "If
 * I'm grouping by 'vaccine' you shouldn't show test appointments" — a
 * point-of-care testing appointment has vaccineNames: [] by construction,
 * so the old "(none)" bucket was really a "test-only appointments"
 * bucket showing up inside a vaccine breakdown; same rationale flips
 * "test" mode to exclude vaccine-only rows with no testNames). Every
 * other mode buckets each row into exactly ONE group.
 *
 * See groupSortKey/compareGroups above for the per-mode "sensible order"
 * groups are returned in.
 */
export function groupRows(rows: ExplorerRow[], mode: GroupByMode): ExplorerRowGroup[] {
  if (mode === "none") return [];

  const groups = new Map<string, ExplorerRow[]>();

  function addTo(key: string, row: ExplorerRow) {
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  for (const row of rows) {
    switch (mode) {
      case "apptDate":
        addTo(row.date, row);
        break;
      case "bookedOn":
        addTo(row.createdDate || "Unknown", row);
        break;
      case "day":
        addTo(dayOfWeekLabel(row.date) || "Unknown", row);
        break;
      case "hour":
        addTo(formatHourLabel(row.hourOfDay), row);
        break;
      case "appointmentType":
        addTo(row.appointmentTypeName, row);
        break;
      case "covidBrand":
        addTo(row.covidBrand, row);
        break;
      case "covidAge":
        addTo(row.covidAgeBucket, row);
        break;
      case "fluAge":
        addTo(row.fluAgeBucket, row);
        break;
      case "vaccine":
        // No "(none)" bucket — a row with zero vaccineNames (a
        // point-of-care testing appointment, e.g.) is excluded from this
        // mode entirely rather than shown under a placeholder group. See
        // this function's own doc comment (V-T28).
        for (const name of row.vaccineNames) addTo(name, row);
        break;
      case "test":
        // Mirrors "vaccine" above: a row with zero testNames (a
        // vaccine-only appointment) is excluded entirely, no "(none)"
        // bucket.
        for (const name of row.testNames) addTo(name, row);
        break;
    }
  }

  return Array.from(groups.entries())
    .map(([group, groupedRows]) => ({ group, rows: groupedRows }))
    .sort((a, b) => compareGroups(a, b, mode));
}

const CSV_HEADERS = [
  "Appt date",
  "Day",
  "Hour",
  "Booked on",
  "Lead days",
  "Appointment type",
  "Vaccines",
  "Tests",
  "# vaccines",
  "COVID brand",
  "COVID age",
  "Flu age",
] as const;

/** RFC-4180-ish quoting: wraps a field in double quotes (doubling any
 * embedded quote) whenever it contains a comma, quote, or newline —
 * otherwise returned as-is. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One row's worth of CSV_HEADERS-ordered field values, shared by
 * rowsToCsv and groupedRowsToCsv below so the two never drift out of sync
 * on column order/formatting. */
function rowToCsvFields(row: ExplorerRow): string[] {
  const lead = computeLeadDays(row);
  return [
    row.date,
    dayOfWeekLabel(row.date),
    formatHourLabel(row.hourOfDay),
    row.createdDate,
    lead === null ? "" : String(lead),
    row.appointmentTypeName,
    row.vaccineNames.join(", "),
    row.testNames.join(", "),
    String(row.vaccineNames.length),
    row.covidBrand,
    row.covidAgeBucket,
    row.fluAgeBucket,
  ];
}

/** Client-side CSV serialization of the filtered rows, same columns as
 * the on-screen table — the caller (the explorer page) turns this into a
 * Blob download. De-identified data only, per this feature's PHI rule, so
 * this is safe to export. */
export function rowsToCsv(rows: ExplorerRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(rowToCsvFields(row).map(csvField).join(","));
  }
  return lines.join("\n");
}

/**
 * Grouped-mode CSV export (V-T27, Will 2026-09-09: "CSV export in
 * group-by mode should include a leading 'Group' column") — same columns/
 * row shape as rowsToCsv, with one extra leading "Group" column carrying
 * each row's own group label. A row that belongs to multiple groups (the
 * "vaccine"/"test" double-membership modes) appears once per group it's
 * in, same as the on-screen grouped tables.
 */
export function groupedRowsToCsv(groups: ExplorerRowGroup[]): string {
  const lines = [["Group", ...CSV_HEADERS].join(",")];
  for (const { group, rows } of groups) {
    for (const row of rows) {
      lines.push([group, ...rowToCsvFields(row)].map(csvField).join(","));
    }
  }
  return lines.join("\n");
}

/**
 * Splits [start, end] (both "YYYY-MM-DD", inclusive) into contiguous,
 * non-overlapping chunks of at most `maxDays` days each, covering the
 * whole range — used by the explorer page to page a caller-selected range
 * wider than the poll route's own MAX_RANGE_DAYS cap into sequential
 * `?rows=1` requests. E.g. a 70-day range with maxDays=31 yields three
 * chunks of 31/31/8 days. Pure date-component math (UTC-noon anchors),
 * same DST-proof approach as lib/chicago-date.ts's addDaysToChicagoDate —
 * deliberately re-implemented here rather than imported, so this file
 * stays a single, dependency-free module per the explorer's
 * "keep the logic in 2 files, unit-testable" brief.
 */
export function chunkDateRange(start: string, end: string, maxDays: number): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let chunkStart = start;

  while (chunkStart <= end) {
    const naiveEnd = addDays(chunkStart, maxDays - 1);
    const chunkEnd = naiveEnd > end ? end : naiveEnd;
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStart = addDays(chunkEnd, 1);
  }

  return chunks;
}

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * `dateStr` ("YYYY-MM-DD") + `months` calendar months, still "YYYY-MM-DD"
 * — backs the explorer's default date range (V-T28, Will 2026-09-09:
 * "default to today ... go forward 3 months"), a genuine calendar-month
 * add rather than a fixed 91-day approximation, so e.g. 2026-11-30 + 3
 * months lands on 2027-02-28 (calendar Feb's real last day), not some
 * fixed-day-count guess. Same UTC-noon-anchored, DST-proof approach as
 * addDays/chunkDateRange above. When the target month is shorter than
 * `dateStr`'s own day-of-month (e.g. Jan 31 + 1 month, where February has
 * no 31st), JS's Date would otherwise silently spill into the month
 * AFTER the intended one (Jan 31 + 1 month -> naive Mar 3) — clamped
 * instead to the intended target month's own LAST day (Feb 28/29).
 */
export function addMonthsToDate(dateStr: string, months: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const intendedMonthIndex0 = month - 1 + months;
  const date = new Date(Date.UTC(year, intendedMonthIndex0, day, 12));
  const normalizedIntendedMonth = ((intendedMonthIndex0 % 12) + 12) % 12;
  if (date.getUTCMonth() !== normalizedIntendedMonth) {
    // Overflowed past the intended month (e.g. no Feb 31st) — "day 0" of
    // the CURRENT (over-shot) month is JS shorthand for the last day of
    // the PREVIOUS month, i.e. exactly the intended target month's last
    // day.
    date.setUTCDate(0);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * V-T24 (Will, verbatim): "The filtering option needs to be more refined,
 * it's very clunky right now and I don't see a way to clear the filters."
 * The rebuild moves the always-visible native `<select multiple>`/text
 * filter row (app/appointments/explorer/page.tsx) behind a per-column
 * popover (filter icon in the header) plus an active-filter CHIP row above
 * the table — these two pure helpers back that chip row; every other
 * popover-open/close/search-within-popover concern is UI-local state that
 * lives in the page component (no new filter LOGIC, only new filter UI —
 * lib/appointment-explorer.ts's applyFilters/EMPTY_EXPLORER_FILTERS
 * contract from before this round is untouched).
 */

/** One text-column filter field, in the exact left-to-right order its
 * column appears in the explorer table (see COLUMNS in the page) —
 * shared by activeFilterChips (chip order) below. `search` is
 * deliberately NOT in this list — it's the free-text box above the
 * table, not a per-column filter, and is always ordered LAST in the chip
 * row (see activeFilterChips). */
const TEXT_FILTER_FIELDS = ["apptDateText", "bookedOnText", "leadDaysText", "vaccineCountText"] as const;

/** One enumerated (multi-select) column filter field, same left-to-right
 * column order as TEXT_FILTER_FIELDS. */
const CHECKLIST_FILTER_FIELDS = [
  "day",
  "hour",
  "appointmentType",
  "vaccine",
  "tests",
  "covidBrand",
  "covidAge",
  "fluAge",
] as const;

/** Human-readable label prefix for each filterable field's chip — e.g.
 * "Lead days: 3", "Day: Mon, Tue". Matches the exact column labels
 * app/appointments/explorer/page.tsx's COLUMNS array already uses. */
const FILTER_FIELD_LABELS: Record<
  (typeof TEXT_FILTER_FIELDS)[number] | (typeof CHECKLIST_FILTER_FIELDS)[number],
  string
> = {
  apptDateText: "Appt date",
  bookedOnText: "Booked on",
  leadDaysText: "Lead days",
  vaccineCountText: "# vaccines",
  day: "Day",
  hour: "Hour",
  appointmentType: "Appointment type",
  vaccine: "Vaccine",
  tests: "Tests",
  covidBrand: "COVID brand",
  covidAge: "COVID age",
  fluAge: "Flu age",
};

/** One chip in the active-filter row — `key` is the exact ExplorerFilters
 * field this chip represents (used by clearFilterKey to remove just this
 * one filter when its own ✕ is clicked), `label` is the full display text
 * (e.g. "Day: Mon, Tue"). */
export type FilterChip = {
  key: keyof ExplorerFilters;
  label: string;
};

/**
 * One chip per currently-active filter, in a fixed, deterministic order
 * (every text column, then every checklist column, in the same
 * left-to-right order they appear in the explorer table, with `search`
 * always last — matching the brief's own example: "Day: Mon, Tue ✕",
 * "Lead days: 3 ✕", "Search: flu ✕"). A filter counts as "active" the
 * same way applyFilters treats it: a text field is active when its
 * TRIMMED value is non-empty; a checklist field is active when its array
 * is non-empty. Returns [] when no filter (including search) is active —
 * the caller renders no chip row (and no "Clear all filters" button) in
 * that case.
 */
export function activeFilterChips(filters: ExplorerFilters): FilterChip[] {
  const chips: FilterChip[] = [];

  for (const field of TEXT_FILTER_FIELDS) {
    const value = filters[field].trim();
    if (value) chips.push({ key: field, label: `${FILTER_FIELD_LABELS[field]}: ${value}` });
  }

  for (const field of CHECKLIST_FILTER_FIELDS) {
    const values = filters[field];
    if (values.length > 0) chips.push({ key: field, label: `${FILTER_FIELD_LABELS[field]}: ${values.join(", ")}` });
  }

  const search = filters.search.trim();
  if (search) chips.push({ key: "search", label: `Search: ${search}` });

  return chips;
}

/**
 * Resets exactly ONE filter field back to its EMPTY_EXPLORER_FILTERS
 * default (a text field back to "", a checklist field back to []) —
 * backs a single chip's own ✕ and a column header's popover "Clear" link.
 * Every other field on `filters` is left untouched.
 */
export function clearFilterKey(filters: ExplorerFilters, key: keyof ExplorerFilters): ExplorerFilters {
  // A FRESH "" or [] — not a reference to EMPTY_EXPLORER_FILTERS[key] —
  // same rationale as clearAllFilters below: reusing that shared array
  // instance would let a later mutation of the returned filters object
  // corrupt the EMPTY_EXPLORER_FILTERS singleton for every other caller.
  const empty: string | string[] = Array.isArray(filters[key]) ? [] : "";
  return { ...filters, [key]: empty };
}

/**
 * Resets every filter (search included) back to EMPTY_EXPLORER_FILTERS —
 * backs the "Clear all filters" button above the table. Deliberately does
 * NOT touch the date range (draftStart/appliedStart/appliedEnd) or the
 * "Appointment date | Booking date" range-basis toggle (rangeBasis) — per
 * the brief, verbatim: "also resets search; NOT the date range or basis."
 * Both of those live as separate page-level state outside ExplorerFilters
 * entirely, so this function has no way to touch them even by accident.
 */
export function clearAllFilters(): ExplorerFilters {
  // Fresh arrays per call, NOT a shallow spread of EMPTY_EXPLORER_FILTERS
  // — a shallow `{ ...EMPTY_EXPLORER_FILTERS }` would hand every caller
  // the SAME array instances for day/hour/etc., so one caller mutating
  // its own "cleared" filters (e.g. a later `setFilters` push, or just an
  // accidental in-place edit) would corrupt the shared
  // EMPTY_EXPLORER_FILTERS singleton for every other caller.
  return {
    search: "",
    apptDateText: "",
    bookedOnText: "",
    leadDaysText: "",
    vaccineCountText: "",
    day: [],
    hour: [],
    appointmentType: [],
    vaccine: [],
    tests: [],
    covidBrand: [],
    covidAge: [],
    fluAge: [],
  };
}
