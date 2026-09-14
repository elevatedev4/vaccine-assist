import { describe, expect, it } from "vitest";
import { describeRules } from "@/lib/screener-info";
import type { ConditionItem, ScreenerVaccineRule } from "@/lib/screener-rules";

// Small synthetic rule set covering every ScreenerStatus tier kind, an
// age band with no max (ageMin only), an age band with no min (ageMax
// only), a tier with no age gate at all, and a tier with no
// requiredConditions — deliberately independent of the real
// SCREENER_RULES/CONDITION_ITEMS data (which is being re-researched in
// parallel) so this test doesn't drift with it.
const CONDITION_ITEMS: ConditionItem[] = [
  { key: "pregnant", label: "Pregnant" },
  { key: "hiv", label: "HIV" },
  { key: "chronicLungDisease", label: "Chronic lung disease" },
] as unknown as ConditionItem[];

const RULES: ScreenerVaccineRule[] = [
  {
    id: "widgetvax",
    name: "Widgetvax",
    sourceUrl: "https://example.com/widgetvax",
    tiers: [
      // routine, age-min-only (no max) — "50+"
      { ageMin: 50, status: "routine", reason: "Routine, age 50+." },
      // risk (condition-based), full age range — "12–64"
      {
        ageMin: 12,
        ageMax: 64,
        requiredConditions: ["hiv", "chronicLungDisease"],
        status: "risk",
        reason: "Age 12-64 with a qualifying condition.",
      },
      // consider, age-max-only (no min) — "up to 11"
      { ageMax: 11, status: "consider", reason: "Shared decision-making under 12." },
      // caution, no age gate at all, condition-gated — "any age"
      { requiredConditions: ["pregnant"], status: "caution", reason: "Avoid during pregnancy." },
      // info, no age gate, no conditions
      { status: "info", reason: "Also ask about travel history." },
      // not-indicated tier explicitly in the list (not just the fallback)
      { ageMin: 65, ageMax: 74, status: "not-indicated", reason: "Not indicated 65-74." },
    ],
    fallback: { status: "not-indicated", reason: "Default: not indicated." },
  },
  {
    id: "sparsevax",
    name: "Sparsevax",
    sourceUrl: "https://example.com/sparsevax",
    tiers: [],
    fallback: { status: "info", reason: "Ask a screening question first." },
  },
];

function vaccine(id: string) {
  const described = describeRules(RULES, CONDITION_ITEMS);
  const found = described.find((v) => v.id === id);
  if (!found) throw new Error(`no described vaccine for ${id}`);
  return found;
}

describe("describeRules — Widgetvax (every tier kind)", () => {
  const v = vaccine("widgetvax");

  it("routine tier: age-min-only formats as '50+', no conditions text", () => {
    expect(v.routine).toHaveLength(1);
    expect(v.routine[0].ageRangeText).toBe("50+");
    expect(v.routine[0].conditions).toBeNull();
    expect(v.routine[0].reason).toBe("Routine, age 50+.");
  });

  it("risk (condition-based) tier: full range formats as '12–64', conditions sorted alphabetically", () => {
    expect(v.conditionBased).toHaveLength(1);
    expect(v.conditionBased[0].ageRangeText).toBe("12–64");
    expect(v.conditionBased[0].conditions).toEqual(["Chronic lung disease", "HIV"]);
  });

  it("consider tier: age-max-only formats as 'up to 11'", () => {
    expect(v.consider).toHaveLength(1);
    expect(v.consider[0].ageRangeText).toBe("up to 11");
  });

  it("caution tier: no age gate formats as 'any age', shows its condition", () => {
    expect(v.caution).toHaveLength(1);
    expect(v.caution[0].ageRangeText).toBe("any age");
    expect(v.caution[0].conditions).toEqual(["Pregnant"]);
  });

  it("info tier: no age gate, no conditions", () => {
    expect(v.info).toHaveLength(1);
    expect(v.info[0].ageRangeText).toBe("any age");
    expect(v.info[0].conditions).toBeNull();
    expect(v.info[0].reason).toBe("Also ask about travel history.");
  });

  it("not-indicated bucket includes both the explicit tier AND the fallback, in order", () => {
    expect(v.notIndicated).toHaveLength(2);
    expect(v.notIndicated[0].ageRangeText).toBe("65–74");
    expect(v.notIndicated[0].reason).toBe("Not indicated 65-74.");
    expect(v.notIndicated[1].ageRangeText).toBe("any age");
    expect(v.notIndicated[1].reason).toBe("Default: not indicated.");
  });

  it("sources are deduped to the rule's single sourceUrl", () => {
    expect(v.sources).toEqual(["https://example.com/widgetvax"]);
  });
});

describe("describeRules — Sparsevax (no tiers, only a fallback)", () => {
  const v = vaccine("sparsevax");

  it("fallback status routes to the info bucket", () => {
    expect(v.info).toHaveLength(1);
    expect(v.info[0].reason).toBe("Ask a screening question first.");
    expect(v.info[0].ageRangeText).toBe("any age");
  });

  it("every other bucket is empty", () => {
    expect(v.routine).toEqual([]);
    expect(v.conditionBased).toEqual([]);
    expect(v.consider).toEqual([]);
    expect(v.caution).toEqual([]);
    expect(v.notIndicated).toEqual([]);
  });

  it("source is still recorded even with zero real tiers", () => {
    expect(v.sources).toEqual(["https://example.com/sparsevax"]);
  });
});

describe("describeRules — age formatting edge cases", () => {
  it("formats a fractional-year (6-month) bound as 'N mo'", () => {
    const rules: ScreenerVaccineRule[] = [
      {
        id: "monthstest",
        name: "Monthstest",
        sourceUrl: "https://example.com/monthstest",
        tiers: [{ ageMin: 0.5, status: "routine", reason: "6 months and up." }],
        fallback: { status: "not-indicated", reason: "Under 6 months." },
      },
    ];
    const [described] = describeRules(rules, CONDITION_ITEMS);
    expect(described.routine[0].ageRangeText).toBe("6 mo+");
  });

  it("preserves rule order (vaccines returned in the same order as the input rules)", () => {
    const described = describeRules(RULES, CONDITION_ITEMS);
    expect(described.map((v) => v.id)).toEqual(["widgetvax", "sparsevax"]);
  });
});

describe("describeRules — condition sorting is case-insensitive", () => {
  it("sorts mixed-case labels alphabetically, ignoring case", () => {
    // Case-sensitive ASCII sort would put "Banana Corp" before "apple
    // disease" (uppercase 'B' sorts before lowercase 'a'); the
    // case-insensitive sort must put "apple disease" first.
    const conditionItems: ConditionItem[] = [
      { key: "condA", label: "Banana Corp" },
      { key: "condB", label: "apple disease" },
      { key: "condC", label: "Cherry syndrome" },
    ] as unknown as ConditionItem[];
    const rules: ScreenerVaccineRule[] = [
      {
        id: "sortvax",
        name: "Sortvax",
        sourceUrl: "https://example.com/sortvax",
        tiers: [
          {
            requiredConditions: ["condA", "condB", "condC"],
            status: "risk",
            reason: "Any qualifying condition.",
          },
        ],
        fallback: { status: "not-indicated", reason: "Default." },
      },
    ] as unknown as ScreenerVaccineRule[];
    const [described] = describeRules(rules, conditionItems);
    expect(described.conditionBased[0].conditions).toEqual([
      "apple disease",
      "Banana Corp",
      "Cherry syndrome",
    ]);
  });
});
