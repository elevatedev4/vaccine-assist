import { describe, expect, it } from "vitest";
import { defaultBudEnabledProductKeys, isBudFieldVisible } from "@/lib/lots-bud-defaults";

// V-lots-bud-spikevax (Will 2026-09-25 4:58pm verbatim): "vaccine lots:
// make sure Moderna Spikevax 2026-27 always has Beyond use date showed.
// It keeps hiding itself." Root cause was lib/lots-settings.ts's
// defaultBudEnabledProductKeys only matching "mnexspike" — Spikevax
// never appeared in the default set, so any settings-load failure (or a
// fresh app_setting row) hid its BUD field. Fixed here by matching both
// "mnexspike" and "spikevax" substrings of the display name.
describe("defaultBudEnabledProductKeys", () => {
  it("defaults to mNEXSPIKE's productKey (computed live, not hardcoded)", () => {
    const vaccines = [
      { id: "v-fluad", name: "Fluad", ndc: "70461-0123-03", active: true },
      { id: "v-mnexspike", name: "mNEXSPIKE", ndc: null, active: true },
    ];
    expect(defaultBudEnabledProductKeys(vaccines)).toEqual(["name:mnexspike"]);
  });

  it("also defaults to Moderna Spikevax 2026-27's productKey", () => {
    const vaccines = [{ id: "v-spikevax", name: "Spikevax 2026-27 (6 mo-11 yr)", ndc: null, active: true }];
    expect(defaultBudEnabledProductKeys(vaccines)).toEqual(["name:spikevax 2026-27 (6 mo-11 yr)"]);
  });

  it("includes BOTH mNEXSPIKE and Spikevax when both are on the catalog", () => {
    const vaccines = [
      { id: "v-mnexspike", name: "mNEXSPIKE", ndc: null, active: true },
      { id: "v-spikevax", name: "Spikevax 2026-27 (6 mo-11 yr)", ndc: null, active: true },
      { id: "v-fluad", name: "Fluad", ndc: "70461-0123-03", active: true },
    ];
    expect(defaultBudEnabledProductKeys(vaccines)).toEqual([
      "name:mnexspike",
      "name:spikevax 2026-27 (6 mo-11 yr)",
    ]);
  });

  it("keeps matching Spikevax across a season rollover (no hardcoded '2026-27')", () => {
    const vaccines = [{ id: "v-spikevax", name: "Spikevax 2027-28 (6 mo-11 yr)", ndc: null, active: true }];
    expect(defaultBudEnabledProductKeys(vaccines)).toEqual(["name:spikevax 2027-28 (6 mo-11 yr)"]);
  });

  it("still finds Spikevax by its real key even if it later gets an NDC on file", () => {
    const withNdc = [{ id: "v-spikevax", name: "Spikevax 2026-27 (6 mo-11 yr)", ndc: "80777-0402-60", active: true }];
    expect(defaultBudEnabledProductKeys(withNdc)).toEqual(["ndc:80777040260"]);
  });

  it("returns [] when no product resembles mNEXSPIKE or Spikevax at all", () => {
    expect(defaultBudEnabledProductKeys([{ id: "v-fluad", name: "Fluad", ndc: null, active: true }])).toEqual([]);
  });
});

describe("isBudFieldVisible", () => {
  it("is visible when the product's BUD setting is enabled, regardless of any existing date", () => {
    expect(isBudFieldVisible(true, null)).toBe(true);
    expect(isBudFieldVisible(true, "")).toBe(true);
    expect(isBudFieldVisible(true, "2026-10-01")).toBe(true);
  });

  it("is visible when the setting is OFF but the row already has a beyond-use date on file", () => {
    expect(isBudFieldVisible(false, "2026-10-01")).toBe(true);
  });

  it("is hidden when the setting is off and there's no existing beyond-use date", () => {
    expect(isBudFieldVisible(false, null)).toBe(false);
    expect(isBudFieldVisible(false, undefined)).toBe(false);
    expect(isBudFieldVisible(false, "")).toBe(false);
    expect(isBudFieldVisible(false, "   ")).toBe(false);
  });
});
