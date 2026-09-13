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
 * Every rule below carries the CDC/ACIP/FDA/label source it was read
 * from (`sourceUrl` on the vaccine) so a pharmacist can verify before
 * administering — see the "Guidance current as of Sept 2026" note
 * rendered at the top of app/screener/page.tsx.
 *
 * Shape: each vaccine is a small ordered list of `tiers` (first match
 * wins) plus a `fallback` used when no tier matches. A tier gates on an
 * age band (inclusive, in YEARS — 0.5 = 6 months) and/or a list of
 * conditions where AT LEAST ONE checked condition satisfies it ("any"
 * semantics — there is no rule below that needs "all of these", so an
 * "all" mode was not added). `lib/screener.ts` is the pure evaluator
 * that walks this data; keep behavior changes here, not there.
 */

/** Every checkbox on the form, in the exact order Will specified. The
 * four `diabetes*` sub-items are independently checkable AND each also
 * implies the "Diabetes" parent is checked (see lib/screener.ts's
 * `deriveConditions` — checking a sub-item auto-ticks "Diabetes" for
 * rule-matching purposes; the page does the same for the on-screen
 * checkbox). */
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
 *    not plain diabetes alone" (Arexvy/Abrysvo's 50-74 risk list).
 *  - `anyCondition`: true when ANY checkbox at all is checked — used
 *    for Comirnaty/mNEXSPIKE's "benefit greatest with a risk factor
 *    present" branch. */
export type DerivedConditionKey = ConditionKey | "diabetesSubItem" | "anyCondition";

export type ScreenerStatus = "routine" | "risk" | "consider" | "caution" | "not-indicated" | "info";

export interface ScreenerTier {
  /** Inclusive lower bound, in years (0.5 = 6 months). Default 0. */
  ageMin?: number;
  /** Inclusive upper bound, in years. Default Infinity. */
  ageMax?: number;
  /** Tier matches if the age band matches AND (this list is empty/absent
   * OR at least one listed key is true). */
  requiredConditions?: DerivedConditionKey[];
  /** Gate on the optional "had a pneumococcal vaccine before?" answer.
   * Only used by Prevnar 20 / Capvaxive. */
  requirePriorPneumo?: "yes" | "no";
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

const PNEUMOCOCCAL_19_49_RISK_CONDITIONS: DerivedConditionKey[] = [
  "chronicLungDisease",
  "coronaryArteryDisease",
  "heartFailure",
  "chronicLiverDisease",
  "chronicKidneyDisease",
  "diabetes",
  "alcohol3Plus",
  "smoking",
  "asplenia",
  "cancer",
  "hiv",
  "immunocompromised",
  "sickleCellOrThalassemia",
  "solidOrganTransplant",
  "cochlearImplant",
  "csfLeak",
];

const RSV_ONE_LIFETIME_DOSE_NOTE =
  "One lifetime dose — no revaccination if previously vaccinated with either brand.";

function pneumococcalRule(id: string, name: string): ScreenerVaccineRule {
  const sourceUrl = "https://www.cdc.gov/pneumococcal/hcp/vaccine-recommendations/index.html";
  return {
    id,
    name,
    sourceUrl,
    tiers: [
      {
        requirePriorPneumo: "yes",
        status: "info",
        reason:
          "Prior PPSV23 only: give PCV20/21 ≥1 year later. Prior PCV20/21: no further dose needed.",
      },
      { ageMin: 50, status: "routine", reason: "Routine, one dose, age 50+." },
      {
        ageMin: 19,
        ageMax: 49,
        requiredConditions: PNEUMOCOCCAL_19_49_RISK_CONDITIONS,
        status: "risk",
        reason: "Age 19-49 with a qualifying risk condition.",
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Age 19-49 without a qualifying risk condition.",
    },
  };
}

export const SCREENER_RULES: ScreenerVaccineRule[] = [
  {
    id: "flucelvax",
    name: "Flucelvax",
    sourceUrl: "https://www.cdc.gov/flu/vaccines-work/vaccineeffect.htm",
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
    sourceUrl: "https://labeling.seqirus.com/PI/US/FLUAD/EN/FLUAD-Prescribing-Information.pdf",
    tiers: [{ ageMin: 65, status: "routine", reason: "Routine annual flu vaccine, age 65+." }],
    fallback: { status: "not-indicated", reason: "Under 65 — use Flucelvax instead." },
  },
  {
    id: "comirnaty",
    name: "Comirnaty",
    sourceUrl: "https://www.cdc.gov/covid/hcp/vaccine-considerations/routine-guidance.html",
    tiers: [
      {
        ageMin: 12,
        requiredConditions: ["anyCondition"],
        status: "risk",
        reason: "Benefit is greatest with a chronic condition or other checked risk factor.",
      },
      {
        ageMin: 12,
        status: "consider",
        reason: "Shared clinical decision-making — offered to all ages 12+.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (12 years)." },
  },
  {
    id: "mnexspike",
    name: "mNEXSPIKE",
    sourceUrl: "https://www.fda.gov/vaccines-blood-biologics/mnexspike",
    tiers: [
      { ageMin: 65, status: "routine", reason: "Routine, age 65+." },
      {
        ageMin: 12,
        ageMax: 64,
        requiredConditions: ["anyCondition"],
        status: "risk",
        reason: "Age 12-64 with a checked risk factor.",
      },
      {
        ageMin: 12,
        ageMax: 64,
        status: "not-indicated",
        reason: "No risk factor checked — use Comirnaty instead.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (12 years)." },
  },
  {
    id: "arexvy",
    name: "Arexvy",
    sourceUrl: "https://www.cdc.gov/rsv/hcp/vaccine-clinical-guidance/index.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "caution",
        reason: "Not recommended in pregnancy — use Abrysvo instead.",
      },
      { ageMin: 75, status: "routine", reason: `Routine, age 75+. ${RSV_ONE_LIFETIME_DOSE_NOTE}` },
      {
        ageMin: 50,
        ageMax: 74,
        requiredConditions: RSV_50_74_RISK_CONDITIONS,
        status: "risk",
        reason: `Age 50-74 with a qualifying risk condition. ${RSV_ONE_LIFETIME_DOSE_NOTE}`,
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Below age 50, or age 50-74 without a qualifying risk condition.",
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
        reason: "One dose at 32-36 weeks of pregnancy, September-January.",
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
        reason: "FDA label only, not ACIP-recommended.",
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
        ageMin: 19,
        ageMax: 49,
        requiredConditions: ["immunocompromised", "hiv", "cancer", "solidOrganTransplant"],
        status: "risk",
        reason: "Age 19-49 with a qualifying immunocompromising condition. 1-2 month interval.",
      },
    ],
    fallback: {
      status: "not-indicated",
      reason: "Below age 19, or age 19-49 without a qualifying condition.",
    },
  },
  {
    id: "engerix-b",
    name: "Engerix-B",
    sourceUrl: "https://www.cdc.gov/mmwr/volumes/71/wr/pdfs/mm7113-h.pdf",
    tiers: [
      { ageMin: 19, ageMax: 59, status: "routine", reason: "Routine universal hepatitis B series, 3 doses." },
      {
        ageMin: 60,
        requiredConditions: ["chronicLiverDisease", "hiv", "diabetes"],
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
    fallback: { status: "not-indicated", reason: "Below routine age range (19-59)." },
  },
  pneumococcalRule("prevnar20", "Prevnar 20"),
  pneumococcalRule("capvaxive", "Capvaxive"),
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
      { ageMin: 11, status: "routine", reason: "One adult Tdap booster, then every 10 years." },
    ],
    fallback: { status: "not-indicated", reason: "Below age 11." },
  },
  {
    id: "gardasil9",
    name: "Gardasil 9",
    sourceUrl: "https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-notes.html",
    tiers: [
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
        ageMin: 2,
        requiredConditions: ["asplenia", "hiv", "immunocompromised"],
        status: "risk",
        reason: "2-dose series, 8-12 weeks apart, booster every 5 years.",
      },
      {
        ageMin: 2,
        status: "not-indicated",
        reason: "Also indicated for complement deficiency/inhibitor use — not asked on this form.",
      },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (2 years)." },
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
        reason: "2-dose hepatitis A series.",
      },
      { ageMin: 1, status: "info", reason: "Travel or behavioral risk — ask." },
    ],
    fallback: { status: "not-indicated", reason: "Below minimum age (1 year)." },
  },
  {
    id: "typhim-vi",
    name: "Typhim Vi",
    // No source URL was given in the brief for Typhim Vi specifically —
    // using CDC's typhoid vaccination page (best fit, not brief-verified
    // like the other sourceUrls). Flagged for Will to confirm.
    sourceUrl: "https://www.cdc.gov/typhoid-fever/hcp/vaccination/index.html",
    tiers: [],
    fallback: { status: "info", reason: "Travel only — ask about travel." },
  },
  {
    id: "mmr",
    name: "M-M-R II",
    sourceUrl: "https://www.cdc.gov/vaccines/hcp/imz-schedules/adult-notes.html",
    tiers: [
      {
        requiredConditions: ["pregnant"],
        status: "caution",
        reason: "Contraindicated — live vaccine. Avoid pregnancy for 1 month after.",
      },
      {
        requiredConditions: ["immunocompromised", "hiv", "cancer", "solidOrganTransplant"],
        status: "caution",
        reason: "Live vaccine — pharmacist judgment (contraindicated if severely immunocompromised).",
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
