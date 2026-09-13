import { describe, expect, it } from "vitest";
import { matchAdministeredRow, matchAdministeredRows } from "@/lib/administered/match";
import type { VaccinationLogRow } from "@/lib/administered/parse";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

const CATALOG: CatalogVaccine[] = [
  { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: null },
  { id: "v-comirnaty", name: "Comirnaty 2026-27 12+", short_code: "comirnaty", ndc: "00069263110" },
  { id: "v-flucelvax-pfs", name: "Flucelvax PFS", short_code: null, ndc: null },
  { id: "v-mmr", name: "MMR-II", short_code: "mmr1", ndc: "00006468100" },
  { id: "v-vaqta", name: "Vaqta adult", short_code: "vaqtaadult1", ndc: "00006409602" },
  { id: "v-shingrix", name: "Shingrix", short_code: "shingrix1", ndc: "58160082311" },
  { id: "v-prevnar20", name: "Prevnar 20", short_code: "prevnar20", ndc: "00005-2000-10, 00005-2000-02" },
  { id: "v-menveo", name: "Menveo", short_code: "menveo", ndc: "58160095509" },
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

  // V-administered-match-mmr-vaqta (Will 2026-09-13): the 8/1-onward
  // Pioneer import left these 2 item names unmatched out of 419 rows.
  it("resolves the Pioneer title-cased MMR name (\"M-M-R Ii\") to MMR-II via the Pioneer alias table", () => {
    const result = matchAdministeredRow(row("M-M-R Ii Vaccine Vial"), CATALOG);
    expect(result.vaccineId).toBe("v-mmr");
  });

  it("resolves the Vaqta adult dose/age variant name to the Vaqta adult catalog row", () => {
    const result = matchAdministeredRow(row("Vaqta 50 Units/ml Syringe (19y+)"), CATALOG);
    expect(result.vaccineId).toBe("v-vaqta");
  });

  // Regression check: the daily file's names that already matched fine
  // before this change must keep matching via the plain free-text
  // matcher, unaffected by the new MMR/Vaqta aliases.
  it("still matches the daily file's existing item names unaffected by the new aliases", () => {
    expect(matchAdministeredRow(row("Shingrix 50 Mcg/0.5 Ml Syringe"), CATALOG).vaccineId).toBe("v-shingrix");
    expect(matchAdministeredRow(row("Prevnar 20 Syringe"), CATALOG).vaccineId).toBe("v-prevnar20");
    expect(matchAdministeredRow(row("Menveo A-C-Y-W-135-Dip vial (12-55y)"), CATALOG).vaccineId).toBe("v-menveo");
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
