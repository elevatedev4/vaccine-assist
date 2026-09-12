import { describe, expect, it } from "vitest";
import { parseVaccinationLog } from "@/lib/administered/parse";

describe("parseVaccinationLog", () => {
  it("decodes an Excel serial datetime as a Chicago wall-clock time (Will's brief example)", () => {
    const matrix = [
      ["Completed date", "Item", ""],
      [46275.6416666667, "Fluad Trivalent 2026-27", ""],
    ];
    const rows = parseVaccinationLog(matrix);
    expect(rows).toHaveLength(1);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    // 15:24 Chicago (CDT, UTC-5) in September -> 20:24 UTC.
    expect(rows[0].completedAt).toBe("2026-09-10T20:24:00.000Z");
    expect(rows[0].itemName).toBe("Fluad Trivalent 2026-27");
  });

  it("decodes a winter (CST, UTC-6) serial correctly", () => {
    // 2026-01-15 09:00 Chicago local time.
    const days = Math.floor((Date.UTC(2026, 0, 15) - Date.UTC(1899, 11, 30)) / 86400000);
    const serial = days + 9 / 24;
    const rows = parseVaccinationLog([
      ["Completed date", "Item"],
      [serial, "Comirnaty 2026-27 12+"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-01-15");
    expect(rows[0].completedAt).toBe("2026-01-15T15:00:00.000Z");
  });

  it("tolerates an already-formatted ISO date-time string with no timezone (csv ingest path)", () => {
    const rows = parseVaccinationLog([
      ["Completed date", "Item"],
      ["2026-09-10 15:24:00", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T20:24:00.000Z");
  });

  it("tolerates a US-style slash date with AM/PM", () => {
    const rows = parseVaccinationLog([
      ["Completed date", "Item"],
      ["9/10/2026 3:24:00 PM", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T20:24:00.000Z");
  });

  it("tolerates a bare date string with no time (defaults to midnight Chicago)", () => {
    const rows = parseVaccinationLog([
      ["Completed date", "Item"],
      ["2026-09-10", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T05:00:00.000Z");
  });

  it("skips the header row wherever it lands, blank rows, and rows missing a date or item name", () => {
    const rows = parseVaccinationLog([
      [null, null],
      ["Completed date", "Item", ""],
      [46275.5, "Flu Quad", ""],
      ["", "", ""],
      [46276.5, "", ""], // blank item name
      ["", "Missing date item", ""], // blank date
      [46277.5, "Fluad Trivalent 2026-27", ""],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.itemName)).toEqual(["Flu Quad", "Fluad Trivalent 2026-27"]);
  });

  it("drops a row with an unparseable date instead of throwing", () => {
    const rows = parseVaccinationLog([
      ["Completed date", "Item"],
      ["not-a-date", "Flu Quad"],
      [46275.5, "Comirnaty"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe("Comirnaty");
  });

  it("tolerates the report's trailing empty 3rd column", () => {
    const rows = parseVaccinationLog([
      ["Completed date", "Item", ""],
      [46275.5, "Flu Quad", ""],
    ]);
    expect(rows).toHaveLength(1);
  });
});
