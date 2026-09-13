import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestVaccinationLogMatrix } from "@/lib/administered/ingest";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

// Same in-memory-Map app_setting stand-in pattern tests/administered-store.test.ts uses.
function fakeSupabase(store: Map<string, unknown> = new Map()) {
  return {
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
  } as never;
}

const CATALOG: CatalogVaccine[] = [{ id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null }];

describe("ingestVaccinationLogMatrix skipped-row reporting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns skipped: 0 and logs nothing for a clean matrix", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ingestVaccinationLogMatrix(
      fakeSupabase(),
      [
        ["Completed date", "Item", ""],
        [46275.6416666667, "Flu Quad 2025-26", ""],
      ],
      CATALOG,
      "source-1"
    );

    expect(result.skipped).toBe(0);
    expect(result.rows).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("counts skipped rows, still ingests the good ones, and warns once with the first offending rows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ingestVaccinationLogMatrix(
      fakeSupabase(),
      [
        ["Completed date", "Item", ""],
        [46275.6416666667, "Flu Quad 2025-26", ""],
        ["not-a-date", "Flu Quad 2025-26", ""], // unparseable date
        [46275.5, "", ""], // blank item name
      ],
      CATALOG,
      "source-1"
    );

    expect(result.skipped).toBe(2);
    expect(result.rows).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, samples] = warnSpy.mock.calls[0];
    expect(String(message)).toContain("skipped 2 row(s)");
    expect(samples).toEqual([
      { date: "not-a-date", item: "Flu Quad 2025-26" },
      { date: "46275.5", item: "" },
    ]);
  });
});

// V-administered-ndc-match, 2026-09-13: the KPI-style export Will now
// also sends logs EVERY fill, not just vaccines, and carries a
// "Dispensed Item NDC" column. Non-matching rows there must be dropped
// (never stored) and counted, and a non-vaccine row's own quantity must
// never expand into multiple stored rows.
describe("ingestVaccinationLogMatrix — non-vaccine rows and dose expansion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NDC_CATALOG: CatalogVaccine[] = [
    { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461012303" },
    { id: "v-shingrix", name: "Shingrix", short_code: "shingrix1", ndc: "58160082311" },
  ];

  it("KPI-shaped matrix: 2 vaccine rows store, 3 non-vaccine rows (one qty 90) are dropped and counted, and the 90 never expands", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ingestVaccinationLogMatrix(
      fakeSupabase(),
      [
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity", "Dispensed Item NDC"],
        [46275.5, "Fluad", 1, "70461-0026-03"],
        [46275.6, "Shingrix", 1, "58160-0823-11"],
        [46275.7, "Synthetic Lisinopril 10mg Tablet", 90, "00000-0000-01"],
        [46275.8, "Synthetic Metformin 500mg Tablet", 60, "00000-0000-02"],
        [46275.9, "Synthetic Amoxicillin 250mg Capsule", 30, "00000-0000-03"],
      ],
      NDC_CATALOG,
      "source-kpi-1"
    );

    expect(result.rows).toBe(2); // only the 2 vaccine rows stored
    expect(result.matched).toBe(2);
    expect(result.nonVaccineRows).toBe(3);
    expect(result.expanded).toBe(0); // neither vaccine row had quantity > 1, and the 90/60/30 non-vaccine rows never expand regardless

    // Never logs the dropped rows' item names — count only.
    const warnMessages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(warnMessages.some((msg) => msg.includes("dropped 3 non-vaccine row"))).toBe(true);
    for (const msg of warnMessages) {
      expect(msg).not.toContain("Lisinopril");
      expect(msg).not.toContain("Metformin");
      expect(msg).not.toContain("Amoxicillin");
    }
  });

  it("KPI-shaped matrix: a matched vaccine row's own integer quantity > 1 still expands into multiple stored rows", async () => {
    const result = await ingestVaccinationLogMatrix(
      fakeSupabase(),
      [
        ["Completed On", "Dispensed Item Name", "Dispensed Quantity", "Dispensed Item NDC"],
        [46275.5, "Fluad", 2, "70461-0026-03"],
        [46275.6, "Synthetic Lisinopril 10mg Tablet", 30, "00000-0000-01"],
      ],
      NDC_CATALOG,
      "source-kpi-2"
    );

    expect(result.rows).toBe(2); // the matched Fluad row expanded x2; the non-vaccine row dropped entirely
    expect(result.expanded).toBe(1);
    expect(result.nonVaccineRows).toBe(1);
  });

  it("classic 2-column daily file (no NDC column): an unmatched row is still stored and counted, not dropped", async () => {
    const result = await ingestVaccinationLogMatrix(
      fakeSupabase(),
      [
        ["Completed date", "Item", ""],
        [46275.5, "Flu Quad 2025-26", ""],
        [46275.6, "Some Brand New Vaccine Name", ""],
      ],
      CATALOG,
      "source-daily-1"
    );

    expect(result.rows).toBe(2); // both stored — the unrecognized name is kept, not dropped
    expect(result.matched).toBe(1);
    expect(result.nonVaccineRows).toBe(0); // no NDC column on this file, so nothing is treated as "non-vaccine"
  });
});
