import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeEffectiveName,
  loadEnvFile,
  nameMatchesAlias,
  parseExpirationToIso,
  parseLotListTsv,
} from "../scripts/apply-lot-list.mjs";

describe("parseLotListTsv", () => {
  it("parses brand/lot/exp rows, treating blank cells as null", () => {
    const tsv = "Brand\tLOT\tEXP\nBoostrix\tL252X\t09/16/28\nFluzone HD\t\t\n";
    expect(parseLotListTsv(tsv)).toEqual([
      { brand: "Boostrix", lot: "L252X", exp: "09/16/28" },
      { brand: "Fluzone HD", lot: null, exp: null },
    ]);
  });

  it("skips blank lines", () => {
    const tsv = "Brand\tLOT\tEXP\n\nBoostrix\tL252X\t09/16/28\n\n";
    expect(parseLotListTsv(tsv)).toEqual([{ brand: "Boostrix", lot: "L252X", exp: "09/16/28" }]);
  });

  it("throws on a missing/wrong header", () => {
    expect(() => parseLotListTsv("Name\tLOT\tEXP\nBoostrix\tL252X\t09/16/28\n")).toThrow(/header/i);
  });

  it("throws on a blank brand cell", () => {
    expect(() => parseLotListTsv("Brand\tLOT\tEXP\n\tL252X\t09/16/28\n")).toThrow(/blank Brand/);
  });

  it("handles a file with no trailing newline", () => {
    const tsv = "Brand\tLOT\tEXP\nBoostrix\tL252X\t09/16/28";
    expect(parseLotListTsv(tsv)).toEqual([{ brand: "Boostrix", lot: "L252X", exp: "09/16/28" }]);
  });
});

describe("parseExpirationToIso", () => {
  it("parses M/D/YY", () => {
    expect(parseExpirationToIso("9/14/25")).toBe("2025-09-14");
  });

  it("parses MM/DD/YYYY", () => {
    expect(parseExpirationToIso("04/12/2027")).toBe("2027-04-12");
  });

  it("parses M/D/YYYY", () => {
    expect(parseExpirationToIso("6/1/26")).toBe("2026-06-01");
  });

  it("throws on an unrecognized format", () => {
    expect(() => parseExpirationToIso("2027-04-12")).toThrow(/Unrecognized date format/);
  });

  it("throws on an out-of-range month/day", () => {
    expect(() => parseExpirationToIso("13/40/27")).toThrow(/out of range/);
  });
});

describe("computeEffectiveName", () => {
  it("renames any mNEXSPIKE-prefixed name to exactly 'mNEXSPIKE 2026-27'", () => {
    expect(computeEffectiveName("mNEXSPIKE")).toBe("mNEXSPIKE 2026-27");
    expect(computeEffectiveName("mNEXSPIKE 2025-26")).toBe("mNEXSPIKE 2026-27");
    expect(computeEffectiveName("mnexspike")).toBe("mNEXSPIKE 2026-27");
  });

  it("renames a 2025-26-labeled COVID row's season to 2026-27, keeping the rest of the name", () => {
    expect(computeEffectiveName("Comirnaty 2025-26 12+")).toBe("Comirnaty 2026-27 12+");
  });

  it("renames any other 2025-26 COVID-keyword row, not just Comirnaty", () => {
    expect(computeEffectiveName("Spikevax 2025-26 6mo-11")).toBe("Spikevax 2026-27 6mo-11");
  });

  it("leaves a non-COVID row with '2025-26' in its name untouched", () => {
    expect(computeEffectiveName("Some Flu Vaccine 2025-26")).toBe("Some Flu Vaccine 2025-26");
  });

  it("leaves an already-correct or unrelated name untouched", () => {
    expect(computeEffectiveName("Boostrix")).toBe("Boostrix");
    expect(computeEffectiveName("Comirnaty 2026-27 12+")).toBe("Comirnaty 2026-27 12+");
  });
});

describe("nameMatchesAlias", () => {
  it("matches when every required substring is present, case-insensitively", () => {
    expect(nameMatchesAlias("Comirnaty 2026-27 12+", ["Comirnaty", "12+"])).toBe(true);
    expect(nameMatchesAlias("comirnaty 2026-27 12+", ["COMIRNATY", "12+"])).toBe(true);
  });

  it("does not match when any required substring is missing", () => {
    expect(nameMatchesAlias("Comirnaty 2026-27 12+", ["Comirnaty", "5-11"])).toBe(false);
  });

  it("matches every dose-variant row sharing a product name (single-requirement alias)", () => {
    expect(nameMatchesAlias("Engerix 20 (age 20+)", ["Engerix"])).toBe(true);
  });
});

describe("loadEnvFile", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads KEY=VALUE lines into the target object, stripping quotes", () => {
    dir = mkdtempSync(path.join(tmpdir(), "apply-lot-list-env-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, '# comment\nSUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY="secret-value"\n\nFOO=\'bar\'\n');

    const target: Record<string, string> = {};
    loadEnvFile(file, target);

    expect(target.SUPABASE_URL).toBe("https://example.supabase.co");
    expect(target.SUPABASE_SERVICE_ROLE_KEY).toBe("secret-value");
    expect(target.FOO).toBe("bar");
  });

  it("never overwrites a key already present on the target", () => {
    dir = mkdtempSync(path.join(tmpdir(), "apply-lot-list-env-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "SUPABASE_URL=from-file\n");

    const target: Record<string, string> = { SUPABASE_URL: "from-real-env" };
    loadEnvFile(file, target);

    expect(target.SUPABASE_URL).toBe("from-real-env");
  });

  it("does nothing (does not throw) when the file does not exist", () => {
    const target: Record<string, string> = {};
    expect(() => loadEnvFile("/nonexistent/path/.env.local", target)).not.toThrow();
    expect(target).toEqual({});
  });
});
