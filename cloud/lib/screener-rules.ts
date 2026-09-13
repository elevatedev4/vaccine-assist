/**
 * Vaccine eligibility SCREENER rule data (V-screener, Will 2026-09-13
 * verbatim: "I want to add a page that helps the pharmacist screen for
 * vaccine eligibility using these health conditions ... select the
 * health conditions the patient did and then be shown a list of
 * eligible vaccines ... also have a box to enter patient age ... since
 * many vaccines are simply based on age.").
 *
 * Deliberately separate from lib/eligibility.ts + the `eligibility_rule`
 * DB table + app/api/eligibility/*: that existing system is a simple
 * age-only gate seeded from the old Macro Express script. This screener
 * is a different, richer, code-defined rule set driven by CDC/ACIP
 * guidance (as of 2026-09) plus checked comorbidities, not by an
 * age-only DB row — hence its own file, its own types, and no shared
 * table. Do not merge the two.
 *
 * ROUND 2 (2026-09-13, coordinator brief): every vaccine's tiers were
 * relinked against a full multi-source review (CDC/ACIP + FDA label +
 * AAP/ACOG) run earlier the same session — see that review's "Changes
 * vs. the prior CDC-only pass" and "Could not confirm" sections for the
 * clinical rationale behind each change below. Every rule below carries
 * the CDC/ACIP/FDA/label source it was read from (`sourceUrl` on the
 * vaccine) so a pharmacist can verify before administering — see the
 * "Guidance current as of Sept 2026" note rendered at the top of
 * app/screener/page.tsx.
 *
 * Shape: each vaccine is a small ordered list of `tiers` (first match
 * wins) plus a `fallback` used when no tier matches. A tier gates on an
 * age band (inclusive, in YEARS — 0.5 = 6 months) and/or a list of
 * conditions where AT LEAST ONE checked condition satisfies it ("any"
 * semantics — there is no rule below that needs "all of these", so an
 * "all" mode was not added). `lib/screener.ts` is the pure evaluator
 * that walks this data; keep behavior changes here, not there.
 *
 * Precedence (coordinator brief, round 2): a "caution" tier is always
 * checked ahead of that vaccine's routine/risk tiers so it is never
 * silently hidden behind an age/condition match — but so the pharmacist
 * doesn't lose the underlying recommendation, `lib/screener.ts`'s
 * `evaluateVaccine` appends "(Would otherwise be routine/risk: ...)" to
 * a caution's displayed reason when a routine/risk tier would otherwise
 * have matched. Abrysvo's pregnancy tier is deliberately "risk", not
 * "caution" (Abrysvo IS the recommended product in pregnancy), so it is
 * never subject to this append.
 */

/** Every checkbox on the form, in the exact order Will specified. The
 * four `diabetes*` sub-items are independently checkable AND each also
 * implies the "Diabetes" parent is checked (see lib/screener.ts's
 * `deriveConditions` — checking a sub-item auto-ticks "Diabetes" for
 * rule-matching purposes; the page does the same for the on-screen
 * checkbox). Per the round-2 review, the four diabetes sub-items are
 * used ONLY by the RSV (Abrysvo/Arexvy) rules below — every other rule
 * keys on the plain "Diabetes" checkbox. */
export type ConditionKey =
  | "asplenia"
  | "cancer"
  | "csfLeak"
  | "cochlearImplant"
  | "coronaryArteryDisease"
  | "chronicKidneyDisease"
  | "chronicLiverDisease"
  | "chronicLungDisease"
  | "diabetes"
  | "diabetesNeuropathy"
  | "diabetesRetinopathy"
  | "diabetesInsulin"
  | "diabetesSglt2"
  | "heartFailure"
  | "hiv"
  | "immunocompromised"
  | "longTermCare"
  | "pregnant"
  | "alcohol3Plus"
  | "severeObesity"
  | "sickleCellOrThalassemia"
  | "smoking"
  | "solidOrganTransplant";

export type ScreenerConditions = Record<ConditionKey, boolean>;

/** Two keys computed FROM the checkboxes above (never set directly by
 * the form) that rules are also allowed to gate on:
 *  - `diabetesSubItem`: true when any of the 4 diabetes sub-checkboxes
 *    is checked — used where the rule is "diabetes-RELATED conditions,
 *    not plain diabetes alone" (Arexvy/Abrysvo's 50-74 risk list, per
 *    ACIP: "diabetes with complications", not diabetes alone).
 *  - `anyCondition`: true when ANY checkbox at all is checked. (Not
 *    used by any round-2 rule — Comirnaty/mNEXSPIKE's risk gate is now
 *    a specific condition list, not "any checkbox" — kept for future
 *    use.) */
export type DerivedConditionKey = ConditionKey | "diabetesSubItem" | "anyCondition";

export type ScreenerStatus = "routine" | "risk" | "consider" | "caution" | "not-indicated" | "info";

/** The optional "prior pneumococcal vaccine" question, used only by
 * Prevnar 20 / Capvaxive's adult tiers (round 2, coordinator brief:
 * replaces the old yes/no toggle with the actual product-sequencing
 * history so the reason text can say what to give next). */
export type PriorPneumoHistory = "none" | "pcv13" | "ppsv23" | "both" | "pcv15_20_21" | "unknown";

export interface ScreenerTier {
  /** Inclusive lower bound, in years (0.5 = 6 months). Default 0. */
  ageMin?: number;
  /** Inclusive upper bound, in years. Default Infinity. */
  ageMax?: number;
  /** Tier matches if the age band matches AND (this list is empty/absent
   * OR at least one listed key is true). */
  requiredConditions?: DerivedConditionKey[];
  /** Gate on the "had a pneumococcal vaccine before, and what?" answer.
   * Only used by Prevnar 20 / Capvaxive. */
  requirePriorPneumo?: PriorPneumoHistory;
  status: ScreenerStatus;
  reason: string;
}

export interface ScreenerVaccineRule {
  id: string;
  name: string;
  sourceUrl: string;
  /** Evaluated in order — first matching tier wins. */
  tiers: ScreenerTier[];
  /** Used when no tier matches. */
  fallback: { status: ScreenerStatus; reason: string };
}

export interface ConditionItem {
  key: ConditionKey;
  label: string;
  /** Rendered as an indented sub-checkbox under its parent. */
  indent?: boolean;
  /** A non-checkbox group label rendered directly above this item
   * (only "Diabetes-related conditions", above the first sub-item). */
  groupHeading?: string;
}

export const CONDITION_ITEMS: ConditionItem[] = [
  { key: "asplenia", label: "Asplenia (no spleen)" },
  { key: "cancer", label: "Cancer (including blood cancer)" },
  { key: "csfLeak", label: "Cerebrospinal fluid leak" },
  { key: "cochlearImplant", label: "Cochlear implant" },
  { key: "coronaryArteryDisease", label: "Coronary artery disease" },
  { key: "chronicKidneyDisease", label: "Chronic kidney disease" },
  { key: "chronicLiverDisease", label: "Chronic liver disease" },
  { key: "chronicLungDisease", label: "Chronic lung disease (Asthma, COPD, etc)" },
  { key: "diabetes", label: "Diabetes" },
  {
    key: "diabetesNeuropathy",
    label: "Neuropathy",
    indent: true,
    groupHeading: "Diabetes-related conditions",
  },
  { key: "diabetesRetinopathy", label: "Retinopathy", indent: true },
  { key: "diabetesInsulin", label: "Insulin treatment", indent: true },
  { key: "diabetesSglt2", label: "SGLT2-I treatment (eg. Jardiance, Farxiga)", indent: true },
  { key: "heartFailure", label: "Heart Failure" },
  { key: "hiv", label: "HIV" },
  { key: "immunocompromised", label: "Immunocompromised" },
  { key: "longTermCare", label: "Long-term care resident" },
  { key: "pregnant", label: "Pregnant" },
  { key: "alcohol3Plus", label: "Regularly consume 3+ alcoholic drinks/day" },
  { key: "severeObesity", label: "Severe Obesity: BMI≥40" },
  { key: "sickleCellOrThalassemia", label: "Sickle cell disease or thalassemia" },
  { key: "smoking", label: "Smoking, current or former" },
  { key: "solidOrganTransplant", label: "Solid organ transplant" },
];

export const DIABETES_SUB_KEYS: ConditionKey[] = [
  "diabetesNeuropathy",
  "diabetesRetinopathy",
  "diabetesInsulin",
  "diabetesSglt2",
];

export const DEFAULT_CONDITIONS: ScreenerConditions = CONDITION_ITEMS.reduce((acc, item) => {
  acc[item.key] = false;
  return acc;
}, {} as ScreenerConditions);

// Shared condition lists reused across more than one vaccine's tiers,
// named for what they mean clinically (kept as single sources of truth
// so Arexvy/Abrysvo, and separately Prevnar20/Capvaxive, can't drift
// apart from each other by accident).
const RSV_50_74_RISK_CONDITIONS: DerivedConditionKey[] = [
  "chronicLungDisease",
  "coronaryArteryDisease",
  "heartFailure",
  "chronicLiverDisease",
  "chronicKidneyDisease",
  "diabetesSubItem",
  "sickleCellOrThalassemia",
  "severeObesity",
  "immunocompromised",
  "longTermCare",
];

// Round 2 correction (coordinator, after review): Heart Failure IS on
// this list — ACIP's "chronic heart disease" trigger explicitly
// includes congestive heart failure and cardiomyopathies (MMWR
// RR-72(3), 2023; cdc.gov/pneumococcal/hcp/vaccine-recommendations).
// Renamed from "19-49" to "adult" since it's also used, unchanged, as
// the 50+ condition list is age-only (no condition gate at 50+).
const PNEUMOCOCCAL_ADULT_RISK_CONDITIONS: DerivedConditionKey[] = [
  "asplenia",
  "cancer",
  "csfLeak",
  "cochlearImplant",
  "coronaryArteryDisease",
  "heartFailure",
  "chronicKidneyDisease",
  "chronicLiverDisease",
  "chronicLungDisease",
  "diabetes",
  "hiv",
  "immunocompromised",
  "alcohol3Plus",
  "sickleCellOrThalassemia",
  "smoking",
  "solidOrganTransplant",
];

// Round 2 addition: children 2-18 (Prevnar 20) / 2-17 (Capvaxive) with
// one of these become eligible too — a materially narrower list than
// the adult one (no alcohol/smoking/CAD, since those aren't pediatric
// risk factors per the review's child-risk-based ACIP source).
const PNEUMOCOCCAL_CHILD_RISK_CONDITIONS: DerivedConditionKey[] = [
  "asplenia",
  "sickleCellOrThalassemia",
  "cochlearImplant",
  "csfLeak",
  "immunocompromised",
  "hiv",
  "cancer",
  "chronicKidneyDisease",
  "chronicLiverDisease",
  "solidOrganTransplant",
  "chronicLungDisease",
];

const RSV_ONE_LIFETIME_DOSE_NOTE =
  "One lifetime dose — no revaccination if previously vaccinated with either brand.";

// Comirnaty and mNEXSPIKE are round-2-identical per the coordinator
// brief (both gated to the same 2025-26 FDA label risk framework) —
// hence one shared condition list and one shared rule factory
// (`covidRule` below) instead of each vaccine hand-rolling its own.
const COVID_RISK_CONDITIONS: DerivedConditionKey[] = [
  "cancer",
  "coronaryArteryDisease",
  "heartFailure",
  "chronicLungDisease",
  "chronicKidneyDisease",
  "chronicLiverDisease",
  "diabetes",
  "hiv",
  "immunocompromised",
  "severeObesity",
  "sickleCellOrThalassemia",
  "smoking",
  "solidOrganTransplant",
  "pregnant",
  "longTermCare",
];

function covidRule(id: string, name: string, sourceUrl: string): ScreenerVaccineRule {
  return {
    id,
    name,
    sourceUrl,
    tiers: [
      { ageMin: 65, status: "routine", reason: "Routine, age 65+." },
      {
        ageMin: 12,
        ageMax: 64,
        requiredConditions: COVID_RISK_CONDITIONS,
        status: "risk",
        reason: "Age 12-64 with a qualifying risk condition (2025-26 FDA label).",
      },
      {
        ageMin: 12,
        ageMax: 64,
        status: "consider",
        reason: "Shared clinical decision-making; outside the 2025-26 FDA label.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (12 years)." },
  };
}

// Reason text for the adult pneumococcal tiers, keyed by prior-vaccine
// history — "none" and "unknown" both fall through to the plain "One
// dose." tiers below (no requirePriorPneumo gate needed for those two).
function pneumococcalHistoryReason(history: "pcv13" | "ppsv23" | "both"): string {
  switch (history) {
    case "pcv13":
      return "PCV20/21 ≥1 year after PCV13.";
    case "ppsv23":
      return "PCV20/21 ≥1 year after PPSV23.";
    case "both":
      return "PCV20/21 ≥5 years after the last dose.";
  }
}

/**
 * Shared factory for Prevnar 20 and Capvaxive — round 2 rewrite adds
 * the full prior-dose sequencing logic (a specific history, not a
 * yes/no) and a pediatric risk-based tier (only Capvaxive's differs:
 * "consider" not "risk", per its newer/less-settled 2-17y label).
 *
 * `adultRiskAgeMin` (coordinator correction after round 2): Prevnar
 * 20's condition-based adult tier starts at 19 per the ACIP adult
 * schedule (an 18-year-old with a qualifying condition falls under its
 * own 2-18 child/adolescent tier instead) — but Capvaxive's FDA label
 * is 18+ for adults, so its condition-based tier starts at 18, one year
 * earlier than Prevnar 20's.
 */
function pneumococcalRule(
  id: string,
  name: string,
  sourceUrl: string,
  childAgeMax: number,
  childStatus: "risk" | "consider",
  childReason: string,
  adultRiskAgeMin: number = 19
): ScreenerVaccineRule {
  const historyTiers: ScreenerTier[] = (["pcv15_20_21", "pcv13", "ppsv23", "both"] as const).flatMap(
    (history) => {
      const isComplete = history === "pcv15_20_21";
      const reason = isComplete ? "Series complete — no further dose needed." : pneumococcalHistoryReason(history);
      const status: ScreenerStatus = isComplete ? "not-indicated" : "routine";
      const riskStatus: ScreenerStatus = isComplete ? "not-indicated" : "risk";
      return [
        { requirePriorPneumo: history, ageMin: 50, status, reason },
        {
          requirePriorPneumo: history,
          ageMin: adultRiskAgeMin,
          ageMax: 49,
          requiredConditions: PNEUMOCOCCAL_ADULT_RISK_CONDITIONS,
          status: riskStatus,
          reason,
        },
      ];
    }
  );

  return {
    id,
    name,
    sourceUrl,
    tiers: [
      ...historyTiers,
      {
        ageMin: 2,
        ageMax: childAgeMax,
        requiredConditions: PNEUMOCOCCAL_CHILD_RISK_CONDITIONS,
        status: childStatus,
        reason: childReason,
      },
      { ageMin: 50, status: "routine", reason: "One dose." },
      {
        ageMin: adultRiskAgeMin,
        ageMax: 49,
        requiredConditions: PNEUMOCOCCAL_ADULT_RISK_CONDITIONS,
        status: "risk",
        reason: "One dose.",
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: `Below age 2, or age ${adultRiskAgeMin}-49 without a qualifying risk condition.`,
    },
  };
}

export const SCREENER_RULES: ScreenerVaccineRule[] = [
  {
    id: "flucelvax",
    name: "Flucelvax",
    sourceUrl: "https://labeling.seqirus.com/PI/US/Flucelvax/EN/Flucelvax-Prescribing-Information.pdf",
    tiers: [
      {
        ageMin: 0.5,
        status: "routine",
        reason: "Routine annual flu vaccine, age 6 months and up. Fine in pregnancy.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (6 months)." },
  },
  {
    id: "fluad",
    name: "Fluad",
    sourceUrl: "https://www.fda.gov/media/94583",
    tiers: [{ ageMin: 65, status: "routine", reason: "Routine annual flu vaccine, age 65+." }],
    fallback: { status: "not-indicated", reason: "Under 65 — use Flucelvax instead." },
  },
  covidRule("comirnaty", "Comirnaty", "https://www.fda.gov/media/188486"),
  covidRule("mnexspike", "mNEXSPIKE", "https://www.fda.gov/media/188486"),
  {
    id: "arexvy",
    name: "Arexvy",
    sourceUrl: "https://www.cdc.gov/rsv/hcp/vaccine-clinical-guidance/index.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "caution",
        reason:
          "Not recommended in pregnancy (maternal trial halted for a preterm-birth safety signal) — use Abrysvo instead.",
      },
      { ageMin: 75, status: "routine", reason: `Routine, age 75+. ${RSV_ONE_LIFETIME_DOSE_NOTE}` },
      {
        ageMin: 50,
        ageMax: 74,
        requiredConditions: RSV_50_74_RISK_CONDITIONS,
        status: "risk",
        reason: `Age 50-74 with a qualifying risk condition. ${RSV_ONE_LIFETIME_DOSE_NOTE}`,
      },
      {
        ageMin: 18,
        ageMax: 49,
        requiredConditions: RSV_50_74_RISK_CONDITIONS,
        status: "consider",
        reason: `FDA label (2025) — ACIP endorsement pending. ${RSV_ONE_LIFETIME_DOSE_NOTE}`,
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Below age 18, or age 18-74 without a qualifying risk condition.",
    },
  },
  {
    id: "abrysvo",
    name: "Abrysvo",
    sourceUrl: "https://www.cdc.gov/rsv/hcp/vaccine-clinical-guidance/index.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "risk",
        reason: "One dose at 32-36 weeks of pregnancy, September-January — Abrysvo only.",
      },
      { ageMin: 75, status: "routine", reason: `Routine, age 75+. ${RSV_ONE_LIFETIME_DOSE_NOTE}` },
      {
        ageMin: 50,
        ageMax: 74,
        requiredConditions: RSV_50_74_RISK_CONDITIONS,
        status: "risk",
        reason: `Age 50-74 with a qualifying risk condition. ${RSV_ONE_LIFETIME_DOSE_NOTE}`,
      },
      {
        ageMin: 18,
        ageMax: 49,
        requiredConditions: RSV_50_74_RISK_CONDITIONS,
        status: "consider",
        reason: `FDA label (2025) — ACIP endorsement pending. ${RSV_ONE_LIFETIME_DOSE_NOTE}`,
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Below age 18, or age 18-74 without a qualifying risk condition/pregnancy.",
    },
  },
  {
    id: "shingrix",
    name: "Shingrix",
    sourceUrl: "https://www.cdc.gov/shingles/hcp/vaccine-considerations/index.html",
    tiers: [
      { requiredConditions: ["pregnant"], status: "caution", reason: "Defer during pregnancy." },
      {
        ageMin: 50,
        status: "routine",
        reason: "Routine, age 50+, 2 doses 2-6 months apart.",
      },
      {
        ageMin: 18,
        ageMax: 49,
        requiredConditions: ["immunocompromised", "hiv", "cancer", "solidOrganTransplant"],
        status: "risk",
        reason: "FDA label 18+, ACIP 19+; 1-2 month interval.",
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Below age 18, or age 18-49 without a qualifying condition.",
    },
  },
  {
    id: "engerix-b",
    name: "Engerix-B",
    sourceUrl: "https://www.cdc.gov/mmwr/volumes/71/wr/pdfs/mm7113-h.pdf",
    tiers: [
      { ageMax: 18, status: "routine", reason: "Catch-up routine hepatitis B series, under 19." },
      { ageMin: 19, ageMax: 59, status: "routine", reason: "Routine universal hepatitis B series, 3 doses." },
      {
        ageMin: 60,
        requiredConditions: ["diabetes", "chronicKidneyDisease", "chronicLiverDisease", "hiv"],
        status: "risk",
        reason: "Age 60+ with a qualifying condition.",
      },
      {
        ageMin: 60,
        status: "info",
        reason:
          "Also indicated for injection drug use, incarceration, sexual exposure, or travel to endemic areas — not asked on this form.",
      },
    ],
    // Unreachable in practice — the tiers above cover the full 0-120
    // range — kept for type-safety and in case a future tier narrows.
    fallback: { status: "not-indicated", reason: "Not applicable." },
  },
  pneumococcalRule(
    "prevnar20",
    "Prevnar 20",
    "https://www.cdc.gov/pneumococcal/hcp/vaccine-recommendations/index.html",
    18,
    "risk",
    "Risk-based series, ages 2-18 (PCV20 licensed 6 weeks+)."
  ),
  pneumococcalRule(
    "capvaxive",
    "Capvaxive",
    "https://www.fda.gov/media/179426",
    17,
    "consider",
    "2026 pediatric label; ACIP adoption pending — confirm before administering.",
    18
  ),
  {
    id: "boostrix",
    name: "Boostrix",
    sourceUrl: "https://www.cdc.gov/pertussis/hcp/vaccine-recommendations/index.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "risk",
        reason: "Every pregnancy, at 27-36 weeks.",
      },
      { ageMin: 10, status: "routine", reason: "One adult Tdap booster, then every 10 years." },
    ],
    fallback: { status: "not-indicated", reason: "Below age 10." },
  },
  {
    id: "gardasil9",
    name: "Gardasil 9",
    sourceUrl: "https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-notes.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "caution",
        reason: "Defer remaining doses to postpartum.",
      },
      {
        ageMin: 9,
        ageMax: 26,
        requiredConditions: ["immunocompromised", "hiv", "cancer", "solidOrganTransplant"],
        status: "risk",
        reason: "3-dose series regardless of start age.",
      },
      { ageMin: 9, ageMax: 26, status: "routine", reason: "Routine HPV series, ages 9-26." },
      {
        ageMin: 27,
        ageMax: 45,
        status: "consider",
        reason: "Shared clinical decision-making, ages 27-45.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Age 46 and older — not recommended." },
  },
  {
    id: "menveo",
    name: "Menveo",
    sourceUrl: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7527029/",
    tiers: [
      {
        ageMin: 2 / 12,
        ageMax: 55,
        requiredConditions: ["asplenia", "hiv", "sickleCellOrThalassemia"],
        status: "risk",
        reason: "2 doses 8-12 weeks apart; booster every 5 years while the condition persists.",
      },
      {
        ageMin: 55,
        requiredConditions: ["asplenia", "hiv", "sickleCellOrThalassemia"],
        status: "info",
        reason: "Outside Menveo's label (age ≤55) — a different meningococcal product is needed.",
      },
      {
        // Coordinator correction: immunocompromised isn't on the
        // asplenia/HIV/sickle-cell risk list, but shouldn't be told
        // "not indicated" either — surface it as a discussion point
        // (complement deficiency and eculizumab/ravulizumab therapy are
        // separate ACIP-recognized triggers this form doesn't ask about).
        ageMin: 2 / 12,
        requiredConditions: ["immunocompromised"],
        status: "consider",
        reason: "Complement deficiency / eculizumab users are not on the form — ask.",
      },
      {
        ageMin: 2 / 12,
        status: "info",
        reason:
          "Also indicated for complement deficiency/eculizumab therapy, travel, or first-year dorm residence — not asked on this form.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (2 months)." },
  },
  {
    id: "vaqta",
    name: "Vaqta",
    sourceUrl: "https://www.cdc.gov/hepatitis-a/vaccination/index.html",
    tiers: [
      {
        ageMin: 1,
        requiredConditions: ["chronicLiverDisease", "hiv"],
        status: "risk",
        reason: "2-dose hepatitis A series, 6-18 months apart.",
      },
      { ageMin: 1, status: "info", reason: "Travel or behavioral risk — ask." },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (1 year)." },
  },
  {
    id: "typhim-vi",
    name: "Typhim Vi",
    // Multi-source review flagged a label-vs-practice conflict: Sanofi's
    // SmPC/label states a 3-year revaccination interval, but CDC/ACIP
    // Yellow Book practice guidance (this brief's instruction) says 2
    // years for continued exposure — using CDC's 2-year figure per the
    // brief, noting the label conflict in the reason text.
    sourceUrl: "https://www.drugs.com/pro/typhim-vi.html",
    tiers: [
      {
        ageMin: 2,
        status: "info",
        reason: "Travel only — ask; revaccinate every 2 years (per CDC; label says 3).",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (2 years)." },
  },
  {
    id: "mmr",
    name: "M-M-R II",
    sourceUrl: "https://www.cdc.gov/measles/hcp/vaccine-considerations/index.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "caution",
        reason: "Contraindicated — live vaccine. Avoid pregnancy for 1 month after.",
      },
      {
        requiredConditions: ["immunocompromised", "cancer", "solidOrganTransplant"],
        status: "caution",
        reason: "Live vaccine — contraindicated if immunosuppressed.",
      },
      {
        requiredConditions: ["hiv"],
        status: "caution",
        reason: "Live vaccine — OK unless severely immunosuppressed (low CD4); pharmacist review.",
      },
      {
        ageMin: 1,
        status: "routine",
        reason: "Routine for adults born 1957 or later without evidence of immunity.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (12 months)." },
  },
];
