/**
 * Pure client-safe helper that reshapes the poll route's flat
 * {date, vaccineName, count} list (see VaccineCount in lib/acuity-client.ts)
 * into a vaccine-rows x day-columns table for app/appointments/page.tsx:
 * one row per exact vaccine name (V-T-something, Will 2026-08-19: "I want
 * to see the exact vaccines they are getting ... COVID-Pfizer,
 * COVID-Moderna, Flu, RSV, etc.", not the generic Acuity appointment-type
 * name), one column per day in the requested range, a per-vaccine 7-day
 * total column, and a daily-total row. Also returns `columns` (see
 * AppointmentTableColumn below) — the same vaccine names as `rows`, but
 * annotated for a grouped two-row header: COVID's brand/age composite
 * names (V-T-schedule-table, Will 2026-09-04) render as one spanning
 * "COVID" group cell over "Pfizer 12+"/"Moderna 3-11"/etc sub-headers,
 * every other vaccine keeps its plain single-row header.
 *
 * No PHI ever reaches this function — it only ever sees the already
 * aggregated counts the poll route returns, never raw appointment data.
 */

export type VaccineCount = {
  date: string; // "YYYY-MM-DD"
  vaccineName: string;
  count: number;
};

export type AppointmentTableRow = {
  vaccineName: string;
  countsByDay: Record<string, number>;
  total: number;
};

/**
 * One table column, in display order — `columns` and `rows` are always
 * the same length with columns[i].vaccineName === rows[i].vaccineName, so
 * a caller can zip them to render cells while using `columns` just for
 * the header. `group` is "COVID" for a COVID · Brand · Age composite
 * column (see covidCompositeName in lib/acuity-client.ts) and null for
 * every other (single-header-row) vaccine column. `label` is what goes in
 * the (second, for COVID) header row — the full vaccineName for a
 * non-COVID column, or "{Brand} {Age}" (e.g. "Pfizer 12+") for a COVID
 * one, since "COVID" itself is shown once in the spanning group cell.
 */
export type AppointmentTableColumn = {
  vaccineName: string;
  group: "COVID" | null;
  label: string;
};

export type AppointmentTable = {
  days: string[];
  rows: AppointmentTableRow[];
  columns: AppointmentTableColumn[];
  dailyTotals: Record<string, number>;
  grandTotal: number;
};

// Matches the exact composite name covidCompositeName (lib/acuity-client.ts)
// builds — "COVID · Pfizer · 12+" etc. Keep the two in sync.
const COVID_COMPOSITE_PATTERN = /^COVID · (Pfizer|Moderna|Any) · (3-11|12\+|Unknown)$/;

// Sort order requested by Will (V-T-schedule-table): brand Pfizer → Moderna
// → Any, age ascending with Unknown last within each brand. Pfizer 3-11
// isn't stocked but sorts like any other bucket if it ever appears — see
// covidCompositeName's caller doc comment.
const COVID_BRAND_ORDER: Record<string, number> = { Pfizer: 0, Moderna: 1, Any: 2 };
const COVID_AGE_ORDER: Record<string, number> = { "3-11": 0, "12+": 1, Unknown: 2 };

function parseCovidComposite(vaccineName: string): { brand: string; age: string } | null {
  const match = COVID_COMPOSITE_PATTERN.exec(vaccineName);
  if (!match) return null;
  return { brand: match[1], age: match[2] };
}

/**
 * Deterministic column order: non-COVID vaccines alphabetically, then the
 * COVID group (brand Pfizer → Moderna → Any, age 3-11 → 12+ → Unknown)
 * placed after them — Will, V-T-schedule-table: "wherever reads cleanest,
 * your call, but deterministic." Two non-COVID names or two COVID
 * composites never tie (Map keys are unique per vaccineName already).
 */
function compareVaccineNames(a: string, b: string): number {
  const covidA = parseCovidComposite(a);
  const covidB = parseCovidComposite(b);

  if (covidA && covidB) {
    return COVID_BRAND_ORDER[covidA.brand] - COVID_BRAND_ORDER[covidB.brand] || COVID_AGE_ORDER[covidA.age] - COVID_AGE_ORDER[covidB.age];
  }
  if (covidA && !covidB) return 1;
  if (!covidA && covidB) return -1;
  return a.localeCompare(b);
}

function buildColumn(vaccineName: string): AppointmentTableColumn {
  const covid = parseCovidComposite(vaccineName);
  if (!covid) return { vaccineName, group: null, label: vaccineName };
  return { vaccineName, group: "COVID", label: `${covid.brand} ${covid.age}` };
}

/**
 * A count entry is normally {date, vaccineName, count} (VaccineCount
 * above). This also tolerates the OLD pre-pivot cached shape
 * {date, appointmentTypeName, count} — a row already sitting in
 * acuity_poll_cache when this change ships — by falling back to
 * appointmentTypeName, and finally to "Unknown", rather than grouping
 * under an "undefined" column or throwing. Stale rows self-heal within
 * one cache TTL (~5 min) once re-fetched from Acuity in the new shape.
 */
function resolveVaccineName(entry: VaccineCount | Record<string, unknown>): string {
  const withVaccineName = entry as { vaccineName?: unknown };
  if (typeof withVaccineName.vaccineName === "string" && withVaccineName.vaccineName.length > 0) {
    return withVaccineName.vaccineName;
  }
  const withTypeName = entry as { appointmentTypeName?: unknown };
  if (typeof withTypeName.appointmentTypeName === "string" && withTypeName.appointmentTypeName.length > 0) {
    return withTypeName.appointmentTypeName;
  }
  return "Unknown";
}

/**
 * `days` is the caller's canonical list of "YYYY-MM-DD" column headers —
 * every row and the daily-totals row are pre-seeded with 0 for each of
 * these so a vaccine/day with no appointments still renders a cell
 * instead of being omitted. Any count entry whose `date` isn't in `days`
 * is ignored rather than silently expanding the table (guards against a
 * stale poll response whose range doesn't line up with the current
 * day columns, e.g. mid-refresh).
 */
export function buildAppointmentTable(counts: VaccineCount[], days: string[]): AppointmentTable {
  const zeroedByDay = (): Record<string, number> => Object.fromEntries(days.map((day) => [day, 0]));

  const rowsByName = new Map<string, AppointmentTableRow>();
  const dailyTotals = zeroedByDay();
  let grandTotal = 0;

  for (const entry of counts) {
    if (!(entry.date in dailyTotals)) continue;

    const vaccineName = resolveVaccineName(entry);

    let row = rowsByName.get(vaccineName);
    if (!row) {
      row = {
        vaccineName,
        countsByDay: zeroedByDay(),
        total: 0,
      };
      rowsByName.set(vaccineName, row);
    }

    row.countsByDay[entry.date] += entry.count;
    row.total += entry.count;
    dailyTotals[entry.date] += entry.count;
    grandTotal += entry.count;
  }

  const rows = Array.from(rowsByName.values()).sort((a, b) => compareVaccineNames(a.vaccineName, b.vaccineName));
  const columns = rows.map((row) => buildColumn(row.vaccineName));

  return { days, rows, columns, dailyTotals, grandTotal };
}
