/**
 * Pure client-safe helper that reshapes the poll route's flat
 * {date, vaccineName, count} list (see VaccineCount in lib/acuity-client.ts)
 * into a vaccine-rows x day-columns table for app/appointments/page.tsx:
 * one row per exact vaccine name (V-T-something, Will 2026-08-19: "I want
 * to see the exact vaccines they are getting ... COVID-Pfizer,
 * COVID-Moderna, Flu, RSV, etc.", not the generic Acuity appointment-type
 * name), one column per day in the requested range, a per-vaccine 7-day
 * total column, and a daily-total row.
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

export type AppointmentTable = {
  days: string[];
  rows: AppointmentTableRow[];
  dailyTotals: Record<string, number>;
  grandTotal: number;
};

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

  const rows = Array.from(rowsByName.values()).sort((a, b) => a.vaccineName.localeCompare(b.vaccineName));

  return { days, rows, dailyTotals, grandTotal };
}
