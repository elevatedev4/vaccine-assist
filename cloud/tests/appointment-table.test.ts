import { describe, expect, it } from "vitest";
import { buildAppointmentTable } from "@/lib/appointment-table";

const DAYS = ["2026-08-17", "2026-08-18", "2026-08-19"];

describe("buildAppointmentTable", () => {
  it("builds one row per appointment type with per-day counts, a 7-day total column, and daily totals", () => {
    const counts = [
      { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 3 },
      { date: "2026-08-18", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 2 },
      { date: "2026-08-17", appointmentTypeId: 222, appointmentTypeName: "COVID Booster", count: 1 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.days).toEqual(DAYS);
    // Rows sorted alphabetically by appointment type name.
    expect(table.rows).toEqual([
      {
        appointmentTypeId: 222,
        appointmentTypeName: "COVID Booster",
        countsByDay: { "2026-08-17": 1, "2026-08-18": 0, "2026-08-19": 0 },
        total: 1,
      },
      {
        appointmentTypeId: 111,
        appointmentTypeName: "Flu Shot",
        countsByDay: { "2026-08-17": 3, "2026-08-18": 2, "2026-08-19": 0 },
        total: 5,
      },
    ]);
    expect(table.dailyTotals).toEqual({ "2026-08-17": 4, "2026-08-18": 2, "2026-08-19": 0 });
    expect(table.grandTotal).toBe(6);
  });

  it("returns zeroed rows/totals for an empty counts list, not an empty table", () => {
    const table = buildAppointmentTable([], DAYS);

    expect(table.rows).toEqual([]);
    expect(table.dailyTotals).toEqual({ "2026-08-17": 0, "2026-08-18": 0, "2026-08-19": 0 });
    expect(table.grandTotal).toBe(0);
  });

  it("ignores a count entry whose date falls outside the requested day columns", () => {
    const counts = [
      { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 2 },
      { date: "2026-09-01", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 99 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows).toEqual([
      {
        appointmentTypeId: 111,
        appointmentTypeName: "Flu Shot",
        countsByDay: { "2026-08-17": 2, "2026-08-18": 0, "2026-08-19": 0 },
        total: 2,
      },
    ]);
    expect(table.grandTotal).toBe(2);
  });

  it("sums multiple entries for the same (type, day) pair rather than overwriting", () => {
    const counts = [
      { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 2 },
      { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 3 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows[0].countsByDay["2026-08-17"]).toBe(5);
    expect(table.rows[0].total).toBe(5);
    expect(table.dailyTotals["2026-08-17"]).toBe(5);
  });
});
