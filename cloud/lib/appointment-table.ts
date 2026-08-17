/**
 * Pure client-safe helper that reshapes the poll route's flat
 * {date, appointmentTypeId, appointmentTypeName, count} list (see
 * AppointmentTypeCount in lib/acuity-client.ts) into a
 * type-rows x day-columns table for app/appointments/page.tsx: one row
 * per vaccine/appointment type, one column per day in the requested
 * range, a per-type 7-day total column, and a daily-total row.
 *
 * No PHI ever reaches this function — it only ever sees the already
 * aggregated counts the poll route returns, never raw appointment data.
 */

export type AppointmentTypeCount = {
  date: string; // "YYYY-MM-DD"
  appointmentTypeId: number;
  appointmentTypeName: string;
  count: number;
};

export type AppointmentTableRow = {
  appointmentTypeId: number;
  appointmentTypeName: string;
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
 * `days` is the caller's canonical list of "YYYY-MM-DD" column headers —
 * every row and the daily-totals row are pre-seeded with 0 for each of
 * these so a type/day with no appointments still renders a cell instead
 * of being omitted. Any count entry whose `date` isn't in `days` is
 * ignored rather than silently expanding the table (guards against a
 * stale poll response whose range doesn't line up with the current
 * day columns, e.g. mid-refresh).
 */
export function buildAppointmentTable(counts: AppointmentTypeCount[], days: string[]): AppointmentTable {
  const zeroedByDay = (): Record<string, number> => Object.fromEntries(days.map((day) => [day, 0]));

  const rowsById = new Map<number, AppointmentTableRow>();
  const dailyTotals = zeroedByDay();
  let grandTotal = 0;

  for (const entry of counts) {
    if (!(entry.date in dailyTotals)) continue;

    let row = rowsById.get(entry.appointmentTypeId);
    if (!row) {
      row = {
        appointmentTypeId: entry.appointmentTypeId,
        appointmentTypeName: entry.appointmentTypeName,
        countsByDay: zeroedByDay(),
        total: 0,
      };
      rowsById.set(entry.appointmentTypeId, row);
    }

    row.countsByDay[entry.date] += entry.count;
    row.total += entry.count;
    dailyTotals[entry.date] += entry.count;
    grandTotal += entry.count;
  }

  const rows = Array.from(rowsById.values()).sort((a, b) =>
    a.appointmentTypeName.localeCompare(b.appointmentTypeName)
  );

  return { days, rows, dailyTotals, grandTotal };
}
