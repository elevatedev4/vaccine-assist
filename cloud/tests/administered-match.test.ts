import { describe, expect, it } from "vitest";
import { matchAdministeredRow, matchAdministeredRows } from "@/lib/administered/match";
import type { VaccinationLogRow } from "@/lib/administered/parse";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: null },
  { id: "v-comirnaty", name: "Comirnaty 2026-27 12+", short_code: "comirnaty", ndc: "00069263110" },
  { id: "v-flucelvax-pfs", name: "Flucelvax PFS", short_code: null, ndc: null },
];

function row(itemName: string): VaccinationLogRow {
  return { completedAt: "2026-09-10T20:24:00.000Z", dateLocal: "2026-09-10", itemName };
}

describe("matchAdministeredRow", () => {
  it("matches a plain catalog-name item via the shared free-text matcher", () => {
    const result = matchAdministeredRow(row("Fluad"), CATALOG);
    expect(result.vaccineId).toBe("v-fluad");
    expect(result.at).toBe("2026-09-10T20:24:00.000Z");
    expect(result.dateLocal).toBe("2026-09-10");
    expect(result.itemName).toBe("Fluad");
  });

  it("resolves via the SAME Pioneer-specific name alias the BOH report's Item Name column uses (Comirnaty)", () => {
    // Same Pioneer noise pattern lib/on-hand/pioneer-boh.ts's
    // PIONEER_NAME_ALIASES documents for the BOH report's Item Name
    // column — proves lib/administered/match.ts reuses that exact table
    // rather than only the plain free-text matcher.
    const result = matchAdministeredRow(row("Mpb Comirnaty 0.1mg Refr Pfs10"), CATALOG);
    expect(result.vaccineId).toBe("v-comirnaty");
  });

  it("resolves the Flucelvax PFS alias too", () => {
    const result = matchAdministeredRow(row("Flucelvax 2026-2027 Syringe"), CATALOG);
    expect(result.vaccineId).toBe("v-flucelvax-pfs");
  });

  it("keeps an unrecognized item name with vaccineId: null rather than dropping it", () => {
    const result = matchAdministeredRow(row("Totally Unknown Vaccine XYZ"), CATALOG);
    expect(result.vaccineId).toBeNull();
    expect(result.itemName).toBe("Totally Unknown Vaccine XYZ");
  });
});

describe("matchAdministeredRows", () => {
  it("maps a batch, preserving order and unmatched rows", () => {
    const rows = [row("Fluad"), row("Nonexistent Product")];
    const results = matchAdministeredRows(rows, CATALOG);
    expect(results).toHaveLength(2);
    expect(results[0].vaccineId).toBe("v-fluad");
    expect(results[1].vaccineId).toBeNull();
  });
});
