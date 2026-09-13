import { describe, expect, it } from "vitest";
import { parseVaccinationLog } from "@/lib/administered/parse";

describe("parseVaccinationLog", () => {
  it("decodes an Excel serial datetime as a Chicago wall-clock time (Will's brief example)", () => {
    const matrix = [
      ["Completed date", "Item", ""],
      [46275.6416666667, "Fluad Trivalent 2026-27", ""],
    ];
    const { rows } = parseVaccinationLog(matrix);
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
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item"],
      [serial, "Comirnaty 2026-27 12+"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-01-15");
    expect(rows[0].completedAt).toBe("2026-01-15T15:00:00.000Z");
  });

  it("tolerates an already-formatted ISO date-time string with no timezone (csv ingest path)", () => {
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item"],
      ["2026-09-10 15:24:00", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T20:24:00.000Z");
  });

  it("tolerates a US-style slash date with AM/PM", () => {
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item"],
      ["9/10/2026 3:24:00 PM", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T20:24:00.000Z");
  });

  it("tolerates a bare date string with no time (defaults to midnight Chicago)", () => {
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item"],
      ["2026-09-10", "Fluad Trivalent 2026-27"],
    ]);
    expect(rows[0].dateLocal).toBe("2026-09-10");
    expect(rows[0].completedAt).toBe("2026-09-10T05:00:00.000Z");
  });

  it("skips the header row wherever it lands, blank rows, and rows missing a date or item name", () => {
    const { rows, skipped } = parseVaccinationLog([
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
    // The [null, null] row, the fully-blank row, the blank-item row, and
    // the blank-date row all have a blank item name and/or unparseable
    // date, so all 4 count as skipped (only the header row is exempt —
    // it's structural, not a dropped data row).
    expect(skipped).toBe(4);
  });

  it("drops a row with an unparseable date instead of throwing", () => {
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item"],
      ["not-a-date", "Flu Quad"],
      [46275.5, "Comirnaty"],
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].itemName).toBe("Comirnaty");
  });

  it("tolerates the report's trailing empty 3rd column", () => {
    const { rows } = parseVaccinationLog([
      ["Completed date", "Item", ""],
      [46275.5, "Flu Quad", ""],
    ]);
    expect(rows).toHaveLength(1);
  });

  it("counts unparseable-date and blank-item rows as skipped, with zero for a clean file", () => {
    const clean = parseVaccinationLog([
      ["Completed date", "Item"],
      [46275.5, "Flu Quad"],
    ]);
    expect(clean.skipped).toBe(0);
    expect(clean.skippedSamples).toEqual([]);

    const dirty = parseVaccinationLog([
      ["Completed date", "Item"],
      ["not-a-date", "Flu Quad"],
      [46275.5, "", ],
      [46276.5, "Comirnaty"],
    ]);
    expect(dirty.skipped).toBe(2);
  });

  it("caps skippedSamples at the first 3 offending rows (date+item strings only)", () => {
    const { skipped, skippedSamples } = parseVaccinationLog([
      ["Completed date", "Item"],
      ["bad-1", "Item A"],
      ["bad-2", "Item B"],
      ["bad-3", "Item C"],
      ["bad-4", "Item D"],
    ]);
    expect(skipped).toBe(4);
    expect(skippedSamples).toHaveLength(3);
    expect(skippedSamples).toEqual([
      { date: "bad-1", item: "Item A" },
      { date: "bad-2", item: "Item B" },
      { date: "bad-3", item: "Item C" },
    ]);
  });

  it("returns expanded: 0 for a file with no quantity column", () => {
    const { expanded } = parseVaccinationLog([
      ["Completed date", "Item"],
      [46275.5, "Flu Quad"],
    ]);
    expect(expanded).toBe(0);
  });

  // V-import-doses-file, 2026-09-13: Will's manually-exported "8/1
  // onward" backfill uses a DIFFERENT header/column set than the daily
  // SES email for the exact same report: "Completed On" (not "Completed
  // date"), "Dispensed Item Name" (not "Item"), plus an optional
  // "Dispensed Quantity" column the daily email never carries. Columns
  // are located BY NAME, so this must work regardless of column order
  // too (quantity is listed BEFORE item name here, on purpose).
  describe("'Completed On / Dispensed Item Name / Dispensed Quantity' header variant", () => {
    it("maps columns by header name, including out-of-order columns", () => {
      const { rows } = parseVaccinationLog([
        ["Completed On", "Dispensed Quantity", "Dispensed Item Name"],
        [46275.5, 0.5, "Fluad 2026-2027 Syringe"],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].itemName).toBe("Fluad 2026-2027 Syringe");
      expect(rows[0].dateLocal).toBe("2026-09-10");
    });

    it("treats a fractional quantity (e.g. 0.5, a vial fraction) as a single dose", () => {
      const { rows, expanded } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity"],
        [46275.5, "Fluad 2026-2027 Syringe", 0.5],
      ]);
      expect(rows).toHaveLength(1);
      expect(expanded).toBe(0);
    });

    it("treats a quantity of exactly 1 as a single dose", () => {
      const { rows, expanded } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity"],
        [46275.5, "Comirnaty", 1],
      ]);
      expect(rows).toHaveLength(1);
      expect(expanded).toBe(0);
    });

    it("expands an integer quantity of 2 into two identical dose rows and counts it in `expanded`", () => {
      const { rows, expanded } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity"],
        [46275.5, "Fluad 2026-2027 Syringe", 2],
      ]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(rows[1]);
      expect(rows[0].itemName).toBe("Fluad 2026-2027 Syringe");
      expect(expanded).toBe(1);
    });

    it("counts only the SOURCE row (not the expanded dose count) in `expanded`, across multiple batch rows", () => {
      const { rows, expanded } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity"],
        [46275.5, "Fluad 2026-2027 Syringe", 3],
        [46276.5, "Comirnaty", 0.3],
        [46277.5, "Shingrix", 2],
      ]);
      expect(rows).toHaveLength(3 + 1 + 2); // 3 Fluad + 1 Comirnaty + 2 Shingrix
      expect(expanded).toBe(2); // the quantity=3 row and the quantity=2 row
    });
  });

  // V-administered-ndc-match, 2026-09-13: Pioneer's daily export and the
  // wider KPI-style export can both carry a "Dispensed Item NDC" column.
  describe("optional NDC column", () => {
    it("leaves `ndc` undefined for the plain daily 2-column export (no NDC column at all)", () => {
      const { rows } = parseVaccinationLog([
        ["Completed date", "Item"],
        [46275.5, "Flu Quad"],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].ndc).toBeUndefined();
    });

    it("maps a 'Dispensed Item NDC' column alongside quantity, normalizing dashes away", () => {
      const { rows } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity", "Dispensed Item NDC"],
        [46275.5, "Fluad 2026-2027 Syringe", 1, "70461-0026-03"],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].ndc).toBe("70461002603");
    });

    it("maps a bare 'NDC' header too", () => {
      const { rows } = parseVaccinationLog([
        ["Completed date", "Item", "NDC"],
        [46275.5, "Flu Quad", "00006409602"],
      ]);
      expect(rows[0].ndc).toBe("00006409602");
    });

    it("leaves `ndc` undefined when the NDC cell is blank, without dropping the row", () => {
      const { rows } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Item NDC"],
        [46275.5, "Fluad 2026-2027 Syringe", ""],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].ndc).toBeUndefined();
    });

    it("carries the same NDC onto every expanded dose row for an integer-quantity batch line", () => {
      const { rows } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity", "Dispensed Item NDC"],
        [46275.5, "Fluad 2026-2027 Syringe", 2, "70461-0026-03"],
      ]);
      expect(rows).toHaveLength(2);
      expect(rows[0].ndc).toBe("70461002603");
      expect(rows[1].ndc).toBe("70461002603");
    });

    // Will's KPI-style export: the same "Completed On / Dispensed Item
    // Name / Dispensed Quantity / Dispensed Item NDC" core columns land
    // among 33 other Rx/patient columns this parser must never read.
    it("parses the 37-column KPI export shape, reading only the 4 known columns by name", () => {
      const otherHeaders = Array.from({ length: 31 }, (_, i) => `Filler Column ${i + 1}`);
      const header = [
        "Rx Number",
        "Patient Name",
        "Completed On",
        ...otherHeaders.slice(0, 10),
        "Dispensed Item Name",
        ...otherHeaders.slice(10, 20),
        "Dispensed Quantity",
        "Dispensed Item NDC",
        ...otherHeaders.slice(20),
      ];
      expect(header).toHaveLength(37);

      const dataRow = header.map((h) => {
        if (h === "Completed On") return 46275.5;
        if (h === "Dispensed Item Name") return "Fluad 2026-2027 Syringe";
        if (h === "Dispensed Quantity") return 1;
        if (h === "Dispensed Item NDC") return "70461-0026-03";
        if (h === "Rx Number") return "RX-SYNTHETIC-0001";
        if (h === "Patient Name") return "Synthetic Test Patient";
        return "synthetic-filler-value";
      });

      const { rows, skipped } = parseVaccinationLog([header, dataRow]);
      expect(rows).toHaveLength(1);
      expect(rows[0].itemName).toBe("Fluad 2026-2027 Syringe");
      expect(rows[0].dateLocal).toBe("2026-09-10");
      expect(rows[0].ndc).toBe("70461002603");
      expect(skipped).toBe(0);
      // Never leaks a patient/Rx field onto the parsed row.
      expect(Object.values(rows[0])).not.toContain("Synthetic Test Patient");
      expect(Object.values(rows[0])).not.toContain("RX-SYNTHETIC-0001");
    });

    it("parses a non-vaccine fill row in the KPI shape the same way — this parser has no catalog, so vaccine-vs-not is decided downstream in match.ts", () => {
      const { rows } = parseVaccinationLog([
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity", "Dispensed Item NDC"],
        [46275.5, "Synthetic Lisinopril 10mg Tablet", 1, "00000-0000-01"],
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].itemName).toBe("Synthetic Lisinopril 10mg Tablet");
      expect(rows[0].ndc).toBe("00000000001");
    });
  });
});
