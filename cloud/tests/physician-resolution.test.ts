import { describe, expect, it } from "vitest";
import {
  resolvePhysician,
  resolvePhysicianRule,
  type Physician,
  type PhysicianRule,
} from "@/lib/physician-resolution";

function rule(overrides: Partial<PhysicianRule> = {}): PhysicianRule {
  return {
    id: "r1",
    physicianId: "p1",
    vaccineId: null,
    minAge: null,
    maxAge: null,
    priority: 0,
    ...overrides,
  };
}

const pharmacist: Physician = { id: "pharmacist", displayName: "Rivera, Ana", alternateId: "ALTPRIMARY" };
const protocolDoc: Physician = { id: "protocol", displayName: "Kim, David", alternateId: "ALTSECOND" };

describe("resolvePhysicianRule", () => {
  it("returns null when no rule matches", () => {
    expect(resolvePhysicianRule([], { vaccineId: "flu", ageYears: 10 })).toBeNull();
  });

  it("matches a wildcard (vaccineId null) rule for any vaccine", () => {
    const wildcard = rule({ vaccineId: null, minAge: 12 });
    expect(resolvePhysicianRule([wildcard], { vaccineId: "shingles", ageYears: 20 })).toEqual(wildcard);
  });

  it("respects min/max age boundaries (inclusive)", () => {
    const bounded = rule({ minAge: 6, maxAge: 17 });
    expect(resolvePhysicianRule([bounded], { vaccineId: "flu", ageYears: 5 })).toBeNull();
    expect(resolvePhysicianRule([bounded], { vaccineId: "flu", ageYears: 6 })).toEqual(bounded);
    expect(resolvePhysicianRule([bounded], { vaccineId: "flu", ageYears: 17 })).toEqual(bounded);
    expect(resolvePhysicianRule([bounded], { vaccineId: "flu", ageYears: 18 })).toBeNull();
  });

  it("a null minAge/maxAge means no floor/ceiling on that side", () => {
    const openEnded = rule({ minAge: 3, maxAge: null });
    expect(resolvePhysicianRule([openEnded], { vaccineId: "flu", ageYears: 90 })).toEqual(openEnded);
  });

  it("a specific-vaccine rule always outranks a wildcard rule for the same age, regardless of priority", () => {
    // Will's own worked example: pharmacist covers flu age 3+ (specific
    // vaccine rule); protocol physician covers "everything else" 12+
    // (wildcard). A 30-year-old asking for flu must resolve to the
    // pharmacist even if the wildcard rule was given a lower (higher-
    // ranking) priority number.
    const specific = rule({ id: "specific", physicianId: "pharmacist", vaccineId: "flu", minAge: 3, priority: 99 });
    const wildcard = rule({ id: "wildcard", physicianId: "protocol", vaccineId: null, minAge: 12, priority: 0 });

    const winner = resolvePhysicianRule([specific, wildcard], { vaccineId: "flu", ageYears: 30 });
    expect(winner?.id).toBe("specific");
  });

  it("falls back to the wildcard rule when no specific-vaccine rule matches", () => {
    const specific = rule({ id: "specific", physicianId: "pharmacist", vaccineId: "flu", minAge: 3, maxAge: 17 });
    const wildcard = rule({ id: "wildcard", physicianId: "protocol", vaccineId: null, minAge: 12 });

    // Age 30 flu: specific rule's maxAge 17 excludes it, wildcard covers it.
    const winner = resolvePhysicianRule([specific, wildcard], { vaccineId: "flu", ageYears: 30 });
    expect(winner?.id).toBe("wildcard");
  });

  it("breaks ties within the same specificity tier by priority ascending", () => {
    const a = rule({ id: "a", vaccineId: "flu", priority: 5 });
    const b = rule({ id: "b", vaccineId: "flu", priority: 1 });

    const winner = resolvePhysicianRule([a, b], { vaccineId: "flu", ageYears: 30 });
    expect(winner?.id).toBe("b");
  });
});

describe("resolvePhysician", () => {
  it("joins the winning rule to its Physician row", () => {
    const rules = [rule({ physicianId: "pharmacist", vaccineId: "flu", minAge: 3 })];
    const result = resolvePhysician(rules, [pharmacist, protocolDoc], { vaccineId: "flu", ageYears: 10 });
    expect(result).toEqual(pharmacist);
  });

  it("returns null when the winning rule's physician row is missing (orphaned rule)", () => {
    const rules = [rule({ physicianId: "does-not-exist", vaccineId: "flu" })];
    const result = resolvePhysician(rules, [pharmacist], { vaccineId: "flu", ageYears: 10 });
    expect(result).toBeNull();
  });

  it("returns null when nothing matches at all", () => {
    const rules = [rule({ vaccineId: "covid", minAge: 12 })];
    const result = resolvePhysician(rules, [pharmacist], { vaccineId: "flu", ageYears: 5 });
    expect(result).toBeNull();
  });

  it("models Will's real-world example end to end", () => {
    // Pharmacist: flu/COVID age 3+, plus childhood vaccines 3-17.
    // Protocol physician (Kim, David): flu 6+ and everything else 12+.
    const rules: PhysicianRule[] = [
      rule({ id: "pharm-flu", physicianId: "pharmacist", vaccineId: "flu", minAge: 3, priority: 0 }),
      rule({ id: "pharm-covid", physicianId: "pharmacist", vaccineId: "covid", minAge: 3, priority: 0 }),
      rule({ id: "pharm-mmr", physicianId: "pharmacist", vaccineId: "mmr", minAge: 3, maxAge: 17, priority: 0 }),
      rule({ id: "protocol-flu", physicianId: "protocol", vaccineId: "flu", minAge: 6, priority: 1 }),
      rule({ id: "protocol-everything-else", physicianId: "protocol", vaccineId: null, minAge: 12, priority: 0 }),
    ];
    const physicians = [pharmacist, protocolDoc];

    // Flu at any age 3+ goes to the pharmacist (specific rule beats the
    // protocol physician's own specific flu rule via priority, and both
    // beat the wildcard).
    expect(resolvePhysician(rules, physicians, { vaccineId: "flu", ageYears: 8 })).toEqual(pharmacist);
    // MMR (a "childhood" vaccine) at 10 -> pharmacist under PREP act.
    expect(resolvePhysician(rules, physicians, { vaccineId: "mmr", ageYears: 10 })).toEqual(pharmacist);
    // MMR at 25 -> no pharmacist rule covers it (maxAge 17), falls to the
    // protocol physician's "everything else 12+" wildcard.
    expect(resolvePhysician(rules, physicians, { vaccineId: "mmr", ageYears: 25 })).toEqual(protocolDoc);
    // Shingles (not named anywhere) at 50 -> wildcard only.
    expect(resolvePhysician(rules, physicians, { vaccineId: "shingles", ageYears: 50 })).toEqual(protocolDoc);
    // Shingles at 8 -> no rule covers it at all (wildcard floor is 12).
    expect(resolvePhysician(rules, physicians, { vaccineId: "shingles", ageYears: 8 })).toBeNull();
  });
});
