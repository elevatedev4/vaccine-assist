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
