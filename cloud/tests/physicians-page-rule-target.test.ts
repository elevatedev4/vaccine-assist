import { describe, expect, it } from "vitest";
import { parseRuleTargetValue } from "@/lib/physician-rule-target";

/**
 * V-cloud-tabs (Will 2026-09-05/07, rule #5): the /physicians rule
 * dropdown's single <select> value encodes either a specific vaccine
 * ("id:<uuid>") or a whole catalog group ("group:<name>") — this is the
 * pure parsing half of that encoding, split out so it's testable without
 * the page's hooks/session state.
 */
describe("parseRuleTargetValue", () => {
  it("parses an id: value into vaccineId, with vaccineGroup null", () => {
    expect(parseRuleTargetValue("id:11111111-1111-1111-1111-111111111111")).toEqual({
      vaccineId: "11111111-1111-1111-1111-111111111111",
      vaccineGroup: null,
    });
  });

  it("parses a group: value into vaccineGroup, with vaccineId null", () => {
    expect(parseRuleTargetValue("group:Flu")).toEqual({ vaccineId: null, vaccineGroup: "Flu" });
  });

  it("returns both null for an empty or unrecognized value", () => {
    expect(parseRuleTargetValue("")).toEqual({ vaccineId: null, vaccineGroup: null });
    expect(parseRuleTargetValue("garbage")).toEqual({ vaccineId: null, vaccineGroup: null });
  });

  it("a group name containing a colon still parses correctly (only the FIRST colon delimits)", () => {
    // No current catalog group has a colon in its name, but the parser
    // itself should not truncate at a second colon.
    expect(parseRuleTargetValue("group:Some:Group")).toEqual({ vaccineId: null, vaccineGroup: "Some:Group" });
  });
});
