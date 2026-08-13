// Eligibility rules decoded by hand from vaccine-add-new.mxe (Macro
// Express 4, 337 lines) — the 24+ CASE blocks under <SWITCH
// Variable="%vaccine%"/> that gated age/eligibility before typing a
// vaccine record into PioneerRx. See supabase/migrations/0001_init.sql
// for the eligibility_rule table this seeds, and cloud/lib/eligibility.ts
// for the runtime evaluation logic that replaces the macro's IF/OR
// blocks.
//
// Condition-code reference (confirmed against the macro's own logic,
// e.g. spikevax311's `age<3 OR age>11` bracketing a 3-11 range):
//   Condition="\x02" == "less than"    (used for min-age floors)
//   Condition="\x03" == "greater than" (used for max-age ceilings)
//
// shortCode below is the macro's OWN short code (the %vaccine% SWITCH
// value). Where the CURRENT formulary (v-macro-codes.xlsx, parsed by
// parse-formulary.mjs) uses a different short_code for what is clearly
// the same or successor product, that's called out explicitly — see
// SHORT_CODE_MISMATCHES at the bottom. build-eligibility-seed.mjs joins
// on vaccine.short_code, so a rule whose shortCode doesn't exist in the
// current formulary simply inserts zero rows (harmless) rather than
// erroring; it's kept here for traceability back to the source macro.

export const ELIGIBILITY_RULES = [
  {
    shortCode: "spikevax12",
    minAge: 12,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'spikevax12': age<12 fails. Not present in the current formulary short_code list " +
      "(Moderna's 12+ covid vaccine appears to have been superseded by mNEXSPIKE) — kept for traceability.",
  },
  {
    // Judgment call: mNEXSPIKE (Moderna 12+, 2025-26) reads as the direct
    // successor to the macro's plain "Spikevax 12+" gate. Same age floor,
    // no known change to the lower bound — applied here rather than left
    // unmapped so the current formulary item still gets SOME gate instead
    // of falling through to "no rule on file."
    shortCode: "mnexspike",
    minAge: 12,
    maxAge: null,
    conditionNote:
      "Age gate inherited from the retired 'spikevax12' macro code (mNEXSPIKE reads as its " +
      "2025-26 successor product) — verify against the current package insert, not re-derived from scratch.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "Judgment call — see comment above. Not a direct macro decode.",
  },
  {
    shortCode: "spikevax311",
    minAge: 3,
    maxAge: 11,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'spikevax311': age<3 OR age>11 fails. Not present in the current formulary short_code " +
      "list — kept for traceability.",
  },
  {
    // Ambiguous mapping, per the brief's instruction to capture ambiguity
    // as a note rather than guess numerics: the formulary's closest
    // product is 'spikevax6mo11' (Moderna 6mo-11), a WIDER band than the
    // macro's 3-11 gate. Left without min/max rather than assume either
    // number is still correct.
    shortCode: "spikevax6mo11",
    minAge: null,
    maxAge: null,
    conditionNote:
      "Old macro's closest equivalent ('spikevax311') gated ages 3-11; this formulary item is labeled " +
      "6mo-11, a wider band. Age range intentionally left unset — verify against the current package " +
      "insert before enforcing a numeric gate.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "Judgment call — ambiguous short_code mapping, no numeric gate guessed.",
  },
  {
    shortCode: "comirnaty12",
    minAge: 12,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'comirnaty12': age<12 fails.",
  },
  {
    shortCode: "pfizer342425",
    minAge: 3,
    maxAge: 4,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'pfizer342425': age<3 OR age>4 fails. Not present in the current formulary short_code " +
      "list — kept for traceability.",
  },
  {
    shortCode: "flucelvaxpfs",
    minAge: 3,
    maxAge: null,
    conditionNote:
      "Fluad is the preferred vaccine for ages 65+. Confirm before entering a regular flu shot for a " +
      "patient 65 or older.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'flucelvaxpfs': age<3 fails; age>64 shows a non-blocking 'preferred vaccine' confirmation, " +
      "not a hard ceiling — captured as condition_note rather than a guessed max_age.",
  },
  {
    shortCode: "afluriamdv",
    minAge: 3,
    maxAge: null,
    conditionNote:
      "Fluad is the preferred vaccine for ages 65+. Confirm before entering a regular flu shot for a " +
      "patient 65 or older.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'afluriamdv': same pattern as flucelvaxpfs above.",
  },
  {
    shortCode: "fluad",
    minAge: 18,
    maxAge: null,
    conditionNote:
      "Ages 18-64 require a documented solid organ transplant; 65+ has no additional requirement.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'fluad': age<18 fails; age<65 (i.e. 18-64) requires a confirmed solid organ transplant " +
      "via a multiple-choice prompt — captured as condition_note.",
  },
  {
    shortCode: "arexvy",
    minAge: 60,
    maxAge: null,
    conditionNote:
      "Ages 60-74 require documented high-risk criteria per the macro's own prompt (which literally " +
      "read '60-75' — verify the exact upper bound against current ACIP guidance before relying on it).",
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'arexvy': age<60 fails; age<75 requires high-risk confirmation. The macro's prompt text " +
      "and its own age<75 condition slightly disagree (75 vs 74) — ambiguous, so no max_age set.",
  },
  {
    shortCode: "shingrix1",
    minAge: 50,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'shingrix1': age<50 fails.",
  },
  {
    shortCode: "shingrix2",
    minAge: 50,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'shingrix2': age<50 fails (dose 2 of the series).",
  },
  {
    shortCode: "engerix1",
    minAge: 20,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'engerix1': age<20 fails (adult Hep B, dose 1).",
  },
  {
    shortCode: "engerix2",
    minAge: 20,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'engerix2': age<20 fails (dose 2).",
  },
  {
    shortCode: "engerix3",
    minAge: 20,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'engerix3': age<20 fails (dose 3).",
  },
  {
    shortCode: "prevnar20",
    minAge: 19,
    maxAge: null,
    conditionNote: "Ages 19-49 require documented high-risk criteria; 50+ has no additional requirement.",
    pregnancyWarning: false,
    priority: 0,
    sourceNote:
      "mxe CASE 'prevnar20': age<19 fails; age<50 (i.e. 19-49) requires high-risk confirmation.",
  },
  {
    shortCode: "boostrix",
    minAge: 10,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'boostrix': age<10 fails.",
  },
  {
    shortCode: "gardasil1",
    minAge: 9,
    maxAge: 45,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'gardasil1': age<9 OR age>45 fails.",
  },
  {
    shortCode: "gardasil2",
    minAge: 9,
    maxAge: 45,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'gardasil2': same gate as gardasil1 (dose 2).",
  },
  {
    shortCode: "gardasil3",
    minAge: 9,
    maxAge: 45,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'gardasil3': same gate as gardasil1 (dose 3).",
  },
  {
    shortCode: "menveo",
    minAge: 3,
    maxAge: 55,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'menveo': age<3 OR age>55 fails.",
  },
  {
    shortCode: "vaqtaadult1",
    minAge: 19,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'vaqtaadult1': age<19 fails.",
  },
  {
    shortCode: "vaqtaadult2",
    minAge: 19,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'vaqtaadult2': same gate as vaqtaadult1 (dose 2).",
  },
  {
    shortCode: "typhim",
    minAge: 3,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: false,
    priority: 0,
    sourceNote: "mxe CASE 'typhim': age<3 fails.",
  },
  {
    shortCode: "mmr1",
    minAge: 3,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: true,
    priority: 0,
    sourceNote:
      "mxe CASE 'mmr1': age<3 fails; unconditional pregnancy warning message (live vaccine).",
  },
  {
    shortCode: "mmr2",
    minAge: 3,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: true,
    priority: 0,
    sourceNote: "mxe CASE 'mmr2': same as mmr1 (dose 2).",
  },
  {
    shortCode: "priorix1",
    minAge: 3,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: true,
    priority: 0,
    sourceNote: "mxe CASE 'priorix1': age<3 fails; unconditional pregnancy warning (live vaccine).",
  },
  {
    shortCode: "priorix2",
    minAge: 3,
    maxAge: null,
    conditionNote: null,
    pregnancyWarning: true,
    priority: 0,
    sourceNote: "mxe CASE 'priorix2': same as priorix1 (dose 2).",
  },
];

// Explicitly NOT seeded, and why (see report to Will for the full
// reasoning — kept here too so the next person reading this file doesn't
// wonder why 2 of the mxe's ~28 CASE blocks are missing):
//
//   medicarehomevisit — not an age/eligibility gate at all. It's a
//     workflow branch (reason-for-visit prompt + per-location service-fee
//     billing) that doesn't tie to a single vaccine_id, so it doesn't fit
//     this table's shape. Phase 2 should model it as an Entry-screen
//     modifier, not an eligibility_rule row.
//
//   DEFAULT CASE (unmatched vaccine) — already the built-in behavior of
//     evaluateEligibilityRules() with an empty rule list: it returns a
//     "warning" status telling staff to review manually, matching the
//     macro's own "vaccine not matched... review age carefully" message.
