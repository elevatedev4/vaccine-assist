import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import { buildMatrix, detectFileKind, parseArgs } from "@/scripts/import-doses-file";
import { parseVaccinationLog, type VaccinationLogRow } from "@/lib/administered/parse";
import { summarizeVaccinationLogRows, unmatchedItemNames } from "@/lib/administered/summarize";
import { matchAdministeredRows, type MatchedAdministeredRow } from "@/lib/administered/match";
import { ingestVaccinationLogMatrix } from "@/lib/administered/ingest";
import type { CatalogVaccine } from "@/lib/vaccine-matching";
import type { AdministeredDay } from "@/lib/administered/store";

// Same in-memory-Map app_setting stand-in tests/administered-store.test.ts
// uses — a real Map so a second ingest call sees the first's writes,
// exactly like two separate script runs against the same real Supabase
// project.
function fakeSupabase() {
  const store = new Map<string, unknown>();
  return {
    client: {
      from: (table: string) => {
        if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }),
            }),
          }),
          upsert: async (row: { key: string; value: unknown }) => {
            store.set(row.key, row.value);
            return { error: null };
          },
        };
      },
    } as never,
    store,
  };
}

function xlsxBuffer(rows: unknown[][]): Buffer {
  const sheet = utils.aoa_to_sheet(rows);
  const workbook = { SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } };
  return write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("detectFileKind", () => {
  it("recognizes xlsx/xls as xlsx", () => {
    expect(detectFileKind("doses.xlsx")).toBe("xlsx");
    expect(detectFileKind("doses.xls")).toBe("xlsx");
    expect(detectFileKind("DOSES.XLSX")).toBe("xlsx");
  });

  it("recognizes csv/tsv/txt as delimited", () => {
    expect(detectFileKind("doses.csv")).toBe("delimited");
    expect(detectFileKind("doses.tsv")).toBe("delimited");
    expect(detectFileKind("doses.txt")).toBe("delimited");
  });

  it("recognizes pdf", () => {
    expect(detectFileKind("doses.pdf")).toBe("pdf");
  });

  it("falls back to unknown for anything else", () => {
    expect(detectFileKind("doses.docx")).toBe("unknown");
    expect(detectFileKind("doses")).toBe("unknown");
  });
});

describe("buildMatrix", () => {
  it("parses an xlsx buffer the same way the SES webhook does", () => {
    const buffer = xlsxBuffer([
      ["Completed date", "Item", ""],
      ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
    ]);
    const matrix = buildMatrix("xlsx", buffer);
    expect(matrix[0]).toEqual(["Completed date", "Item", ""]);
    expect(matrix[1][1]).toBe("Fluad Trivalent 2026-27");
  });

  it("parses delimited (csv) text, auto-detecting comma", () => {
    const buffer = Buffer.from("Completed date,Item\n2026-08-05 10:00,Fluad Trivalent 2026-27\n", "utf-8");
    const matrix = buildMatrix("delimited", buffer);
    expect(matrix[0]).toEqual(["Completed date", "Item"]);
    expect(matrix[1]).toEqual(["2026-08-05 10:00", "Fluad Trivalent 2026-27"]);
  });

  it("parses delimited (tsv) text, auto-detecting tab", () => {
    const buffer = Buffer.from("Completed date\tItem\n2026-08-05 10:00\tFluad Trivalent 2026-27\n", "utf-8");
    const matrix = buildMatrix("delimited", buffer);
    expect(matrix[1]).toEqual(["2026-08-05 10:00", "Fluad Trivalent 2026-27"]);
  });
});

describe("parseArgs", () => {
  it("parses a bare path", () => {
    expect(parseArgs(["file.xlsx"])).toEqual({ filePath: "file.xlsx", received: undefined, dryRun: false });
  });

  it("parses --dry-run in any position", () => {
    expect(parseArgs(["--dry-run", "file.xlsx"])).toEqual({ filePath: "file.xlsx", received: undefined, dryRun: true });
    expect(parseArgs(["file.xlsx", "--dry-run"])).toEqual({ filePath: "file.xlsx", received: undefined, dryRun: true });
  });

  it("parses --received <ISO>", () => {
    expect(parseArgs(["file.xlsx", "--received", "2026-08-01T00:00:00.000Z"])).toEqual({
      filePath: "file.xlsx",
      received: "2026-08-01T00:00:00.000Z",
      dryRun: false,
    });
  });

  it("parses all three flags together, in any order", () => {
    expect(parseArgs(["--received", "2026-08-01T00:00:00.000Z", "--dry-run", "file.xlsx"])).toEqual({
      filePath: "file.xlsx",
      received: "2026-08-01T00:00:00.000Z",
      dryRun: true,
    });
  });

  it("throws when no path is given", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow();
  });
});

describe("summarizeVaccinationLogRows (pure — date range + per-day counts)", () => {
  function row(overrides: Partial<VaccinationLogRow> = {}): VaccinationLogRow {
    return { completedAt: "2026-08-05T15:00:00.000Z", dateLocal: "2026-08-05", itemName: "Fluad Trivalent 2026-27", ...overrides };
  }

  it("returns rowCount 0 and null dateRange for no rows", () => {
    expect(summarizeVaccinationLogRows([])).toEqual({ rowCount: 0, dateRange: null, perDay: {} });
  });

  it("computes min/max date range and per-day counts across several days", () => {
    const rows = [
      row({ dateLocal: "2026-08-05" }),
      row({ dateLocal: "2026-08-01" }),
      row({ dateLocal: "2026-08-05" }),
      row({ dateLocal: "2026-08-03" }),
    ];
    const summary = summarizeVaccinationLogRows(rows);
    expect(summary.rowCount).toBe(4);
    expect(summary.dateRange).toEqual({ min: "2026-08-01", max: "2026-08-05" });
    expect(summary.perDay).toEqual({ "2026-08-01": 1, "2026-08-03": 1, "2026-08-05": 2 });
    // keys iterate in ascending date order
    expect(Object.keys(summary.perDay)).toEqual(["2026-08-01", "2026-08-03", "2026-08-05"]);
  });

  it("handles a single day (min === max)", () => {
    const summary = summarizeVaccinationLogRows([row(), row()]);
    expect(summary.dateRange).toEqual({ min: "2026-08-05", max: "2026-08-05" });
    expect(summary.perDay).toEqual({ "2026-08-05": 2 });
  });
});

describe("unmatchedItemNames", () => {
  function matched(overrides: Partial<MatchedAdministeredRow> = {}): MatchedAdministeredRow {
    return { at: "2026-08-05T15:00:00.000Z", dateLocal: "2026-08-05", itemName: "Fluad Trivalent 2026-27", vaccineId: "v-fluad", ...overrides };
  }

  it("returns nothing when every row matched", () => {
    expect(unmatchedItemNames([matched(), matched()])).toEqual([]);
  });

  it("returns distinct, sorted names for unmatched rows only", () => {
    const rows = [
      matched({ itemName: "Zoster Vax", vaccineId: null }),
      matched({ itemName: "Unknown Product", vaccineId: null }),
      matched({ itemName: "Zoster Vax", vaccineId: null }), // duplicate name, deduped
      matched({ itemName: "Fluad Trivalent 2026-27", vaccineId: "v-fluad" }), // matched, excluded
    ];
    expect(unmatchedItemNames(rows)).toEqual(["Unknown Product", "Zoster Vax"]);
  });
});

describe("duplicate-day safety: two files sharing a day never double-count", () => {
  const catalog: CatalogVaccine[] = [{ id: "v-fluad", name: "Fluad Trivalent 2026-27" }, { id: "v-comirnaty", name: "Comirnaty" }];

  it("re-ingesting the SAME file twice yields the same store contents (idempotent)", async () => {
    const { client, store } = fakeSupabase();
    const buffer = xlsxBuffer([
      ["Completed date", "Item", ""],
      ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
      ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""], // two patients, same minute, same item
    ]);
    const matrix = buildMatrix("xlsx", buffer);

    await ingestVaccinationLogMatrix(client, matrix, catalog, "manual-import:doses.xlsx:t1");
    const afterFirst = JSON.stringify(store.get("administered:2026-08-05"));
    await ingestVaccinationLogMatrix(client, matrix, catalog, "manual-import:doses.xlsx:t1");
    const afterSecond = JSON.stringify(store.get("administered:2026-08-05"));

    const day = store.get("administered:2026-08-05") as AdministeredDay;
    expect(day.rows).toHaveLength(2);
    // Idempotent: identical file ingested twice produces byte-identical
    // rows (only `updatedAt`/`sources` framing could legitimately
    // differ, but rows themselves must match exactly).
    expect(JSON.parse(afterFirst).rows).toEqual(JSON.parse(afterSecond).rows);
  });

  it("the initial bulk (8/1-onward) file and a later overlapping daily file never double-count a shared day", async () => {
    const { client, store } = fakeSupabase();

    // File A: the 8/1-onward bulk backfill. Covers 8/1 and 8/5, with two
    // same-minute Fluad doses on 8/5.
    const fileA = buildMatrix(
      "xlsx",
      xlsxBuffer([
        ["Completed date", "Item", ""],
        ["2026-08-01 09:00", "Comirnaty", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
      ])
    );

    // File B: the routine 3am email a few days later, whose window
    // overlaps 8/5 (repeating BOTH same-minute doses, in REVERSED row
    // order — a real export re-run is not guaranteed to preserve exact
    // row order) plus a genuinely new dose on 8/6.
    const fileB = buildMatrix(
      "xlsx",
      xlsxBuffer([
        ["Completed date", "Item", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
        ["2026-08-06 08:30", "Comirnaty", ""],
      ])
    );

    await ingestVaccinationLogMatrix(client, fileA, catalog, "manual-import:doses-8-1-onward.xlsx:t1");
    await ingestVaccinationLogMatrix(client, fileB, catalog, "inbound_attachment:2026-08-07T03:00:00.000Z:daily.xlsx");

    const aug1 = store.get("administered:2026-08-01") as AdministeredDay;
    const aug5 = store.get("administered:2026-08-05") as AdministeredDay;
    const aug6 = store.get("administered:2026-08-06") as AdministeredDay;

    expect(aug1.rows).toHaveLength(1);
    // The critical assertion: 8/5 has exactly 2 rows (the two real
    // doses), NOT 4 — file B repeating the same-minute pair does not
    // double it.
    expect(aug5.rows).toHaveLength(2);
    expect(aug6.rows).toHaveLength(1);
    expect(aug5.sources).toEqual(["manual-import:doses-8-1-onward.xlsx:t1", "inbound_attachment:2026-08-07T03:00:00.000Z:daily.xlsx"]);
  });

  it("a later file that repeats only ONE of two same-minute doses still ends at 2, not 1 or 3", async () => {
    const { client, store } = fakeSupabase();
    const fileA = buildMatrix(
      "xlsx",
      xlsxBuffer([
        ["Completed date", "Item", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
      ])
    );
    const fileB = buildMatrix(
      "xlsx",
      xlsxBuffer([
        ["Completed date", "Item", ""],
        ["2026-08-05 10:00", "Fluad Trivalent 2026-27", ""],
      ])
    );

    await ingestVaccinationLogMatrix(client, fileA, catalog, "file-a");
    await ingestVaccinationLogMatrix(client, fileB, catalog, "file-b");

    const day = store.get("administered:2026-08-05") as AdministeredDay;
    expect(day.rows).toHaveLength(2);
  });
});
