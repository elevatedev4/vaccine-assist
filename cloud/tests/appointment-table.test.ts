import { describe, expect, it } from "vitest";
import { buildAppointmentTable } from "@/lib/appointment-table";

const DAYS = ["2026-08-17", "2026-08-18", "2026-08-19"];

describe("buildAppointmentTable", () => {
  it("builds one row per exact vaccine name with per-day counts, a 7-day total column, and daily totals", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "Flu", count: 3 },
      { date: "2026-08-18", vaccineName: "Flu", count: 2 },
      { date: "2026-08-17", vaccineName: "COVID-Pfizer", count: 1 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.days).toEqual(DAYS);
    // Rows sorted alphabetically by vaccine name.
    expect(table.rows).toEqual([
      {
        vaccineName: "COVID-Pfizer",
        countsByDay: { "2026-08-17": 1, "2026-08-18": 0, "2026-08-19": 0 },
        total: 1,
      },
      {
        vaccineName: "Flu",
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
      { date: "2026-08-17", vaccineName: "Flu", count: 2 },
      { date: "2026-09-01", vaccineName: "Flu", count: 99 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows).toEqual([
      {
        vaccineName: "Flu",
        countsByDay: { "2026-08-17": 2, "2026-08-18": 0, "2026-08-19": 0 },
        total: 2,
      },
    ]);
    expect(table.grandTotal).toBe(2);
  });

  it("sums multiple entries for the same (vaccineName, day) pair rather than overwriting", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "Flu", count: 2 },
      { date: "2026-08-17", vaccineName: "Flu", count: 3 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows[0].countsByDay["2026-08-17"]).toBe(5);
    expect(table.rows[0].total).toBe(5);
    expect(table.dailyTotals["2026-08-17"]).toBe(5);
  });

  it("puts two distinct vaccines from the same multi-vaccine appointment into separate columns", () => {
    // aggregateAppointmentCounts (lib/acuity-client.ts) already splits a
    // single appointment's vaccineNames into separate {date, vaccineName}
    // entries — this just confirms the table builder doesn't collapse
    // them back together.
    const counts = [
      { date: "2026-08-17", vaccineName: "Flu", count: 1 },
      { date: "2026-08-17", vaccineName: "COVID-Pfizer", count: 1 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows.map((r) => r.vaccineName)).toEqual(["COVID-Pfizer", "Flu"]);
    // Both columns count the one shared appointment day, but the daily
    // total is NOT double-counted per-appointment — it's a sum of the
    // (already-split) count entries, same as any other two rows.
    expect(table.dailyTotals["2026-08-17"]).toBe(2);
  });

  it("falls back to appointmentTypeName (old pre-pivot cache shape) instead of an 'undefined' column", () => {
    const counts = [{ date: "2026-08-17", appointmentTypeName: "Vaccine Appointment", count: 4 }] as never;

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows).toEqual([
      {
        vaccineName: "Vaccine Appointment",
        countsByDay: { "2026-08-17": 4, "2026-08-18": 0, "2026-08-19": 0 },
        total: 4,
      },
    ]);
  });

  it("falls back to 'Unknown' rather than throwing when neither vaccineName nor appointmentTypeName is present", () => {
    const counts = [{ date: "2026-08-17", count: 1 }] as never;

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows).toEqual([
      {
        vaccineName: "Unknown",
        countsByDay: { "2026-08-17": 1, "2026-08-18": 0, "2026-08-19": 0 },
        total: 1,
      },
    ]);
  });
});
