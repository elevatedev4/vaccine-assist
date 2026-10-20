/**
 * /macro-codes hotkeys (Will's verbatim ask, 2026-09-28, 10:31am): "add
 * hotkeys to the vaccines — pushing the hotkey selects the vaccine and
 * copies the code (and advances the data entry in the desktop
 * Ctrl+Keypad 2 flow). The letter should be underlined in the name and
 * pushing the letter once on the screen does the action." Keys are
 * case-insensitive.
 *
 * Will's mapping is "first letter where possible" with a few deliberate
 * substitutions where two products would otherwise collide on the same
 * letter: he originally wrote "U" for both FluMist and Fluad (round 1
 * gave Fluad "A" instead; round 2, 2026-09-28 verbatim answer, moved it
 * to "D") and "P" for both Pfizer 12+ and Prevnar 20 (Prevnar gets "N"
 * instead) — MACRO_HOTKEYS below is that already-resolved, collision-
 * free mapping, not something this module re-derives.
 *
 * This file is pure (no React/DOM) so it can be unit tested directly —
 * app/macro-codes/page.tsx wires it to a document keydown listener and
 * to the SAME handleCopy(row, label) the dose buttons already call, so
 * a hotkey behaves exactly like a click (lot-modal/BUD gating/embed
 * postMessage all included).
 */

import { macroBaseShortCode } from "@/lib/macro-catalog";
import type { MacroDoseButton, MacroProductGroup, MacroRow, MacroTopGroupBlock } from "@/lib/macro-codes";
import { preferredFluForAge } from "@/lib/flu-preference";
import { preferredCovidForAge, type PreferredCovidSetting } from "@/lib/preferred-covid";

/**
 * Lowercase key -> the catalog short code(s) (see lib/macro-catalog.ts's
 * RAW_MACRO_CATALOG) that key selects. A code here can be either a
 * product's real, exact short_code (e.g. "flucelvaxmdv", "comirnaty12" —
 * see that file's header for why a single-dose code's trailing digits
 * are sometimes part of the code itself, not a dose suffix) or its
 * digit-stripped BASE for a multi-dose product ("shingrix" for
 * shingrix1/shingrix2) — shortCodeMatchesHotkeyCodes below tries a row's
 * short_code both ways, same exact-then-base order lib/macro-catalog.ts's
 * lookupMacroCatalog uses. Two codes under one key (e.g. "f" ->
 * flucelvaxmdv/flucelvaxpfs, both "Flucelvax") or two distinct PRODUCTS
 * sharing one key ("i" -> mmr/priorix, both MMR) are both intentional.
 */
export const MACRO_HOTKEYS: Readonly<Record<string, readonly string[]>> = {
  f: ["flucelvaxmdv", "flucelvaxpfs"],
  u: ["flumist"],
  l: ["mflusiva"],
  d: ["fluad"],
  "3": ["spikevax6mo11"],
  p: ["comirnaty12"],
  m: ["mnexspike"],
  r: ["abrysvo"],
  s: ["shingrix"],
  n: ["prevnar20"],
  c: ["capvaxive"],
  b: ["boostrix"],
  g: ["gardasil"],
  e: ["engerix"],
  o: ["menveo"],
  v: ["vaqtaadult"],
  t: ["typhim"],
  i: ["mmr", "priorix"],
};

/** A letter/digit -> catalog short code(s) table (see MACRO_HOTKEYS). */
export type HotkeyMap = Readonly<Record<string, readonly string[]>>;

/**
 * "flu2" hotkey profile (V-Q11, Will 2026-10-20, verbatim): "Update
 * hotkeys. F picks the recommended flu for that age. Flucelvax is X.
 * Fluad is D. mFLUSIVA is V. C chooses the preferred COVID vaccine based
 * on the location settings ... P and M still map to the Pfizer and
 * Moderna."
 *
 * Only the testing desktop opts in (it adds hk=flu2 to the macro-codes
 * URL - see HOTKEY_PROFILE_PARAM below), so the stable desktop and the
 * plain web page keep MACRO_HOTKEYS exactly as it was.
 *
 * Fixed letters here: X Flucelvax, D Fluad, V mFLUSIVA (L, mFLUSIVA's old
 * key, is released). F and C are NOT in this table - they resolve per
 * patient through a SmartHotkeyResolver (see SMART_HOTKEYS_FLU2).
 *
 * Collisions this profile had to resolve (the old map used C and V):
 *   - C was Capvaxive  -> moved to A (it has an "a": cApvaxive)
 *   - V was Vaqta      -> moved to Q (it has a "q": vaQta)
 *   - F was Flucelvax  -> now the smart "recommended flu" key; Flucelvax is X
 * Every other letter/digit is unchanged.
 */
export const MACRO_HOTKEYS_FLU2: HotkeyMap = {
  x: ["flucelvaxmdv", "flucelvaxpfs"],
  u: ["flumist"],
  v: ["mflusiva"],
  d: ["fluad"],
  "3": ["spikevax6mo11"],
  p: ["comirnaty12"],
  m: ["mnexspike"],
  r: ["abrysvo"],
  s: ["shingrix"],
  n: ["prevnar20"],
  a: ["capvaxive"],
  b: ["boostrix"],
  g: ["gardasil"],
  e: ["engerix"],
  o: ["menveo"],
  q: ["vaqtaadult"],
  t: ["typhim"],
  i: ["mmr", "priorix"],
};

/** The keys the flu2 profile resolves per patient instead of from a fixed table. */
export const SMART_HOTKEYS_FLU2: readonly string[] = ["f", "c"];

/** URL query param the desktop uses to opt into a hotkey profile, e.g. /macro-codes?embed=1&age=55&hk=flu2. */
export const HOTKEY_PROFILE_PARAM = "hk";

export type HotkeyProfile = "classic" | "flu2";

/** Reads the profile from the raw query param value; anything unknown (or absent) is "classic". */
export function parseHotkeyProfile(raw: string | null | undefined): HotkeyProfile {
  return (raw ?? "").trim().toLowerCase() === "flu2" ? "flu2" : "classic";
}

export function hotkeyMapForProfile(profile: HotkeyProfile): HotkeyMap {
  return profile === "flu2" ? MACRO_HOTKEYS_FLU2 : MACRO_HOTKEYS;
}

/** What a smart key resolves to for the current patient: the short codes to select, or a short message when it cannot. */
export type SmartHotkeyResult = { codes: readonly string[]; label: string } | { message: string };
export type SmartHotkeyResolver = (lowerKey: string) => SmartHotkeyResult | null;

/** Everything hotkeyTransition needs beyond the key itself; omitted = the classic map, no smart keys. */
export type HotkeyContext = { map?: HotkeyMap; smart?: SmartHotkeyResolver };

/**
 * Builds the flu2 profile's smart-key resolver for one patient:
 *   F -> the preferred flu product for the age (lib/flu-preference.ts, the
 *        same rule as the desktop prompt, so F never triggers it)
 *   C -> the preferred COVID vaccine for the age under the location setting
 *        (12+ -> the 12+ preference, 3-11 -> the kids preference)
 * An unknown age, or one with no product (under 3), yields a short
 * message instead of codes. Any other key returns null (not a smart key).
 */
export function makeFlu2SmartResolver(ageYears: number | null, covid: PreferredCovidSetting): SmartHotkeyResolver {
  return (lowerKey) => {
    if (lowerKey === "f") {
      if (ageYears === null) return { message: "F needs the patient's age - use Ctrl+Keypad 2." };
      const product = preferredFluForAge(ageYears);
      if (!product) return { message: "No flu vaccine under age 3." };
      return { codes: product.shortCodes, label: product.displayName };
    }
    if (lowerKey === "c") {
      if (ageYears === null) return { message: "C needs the patient's age - use Ctrl+Keypad 2." };
      const choice = preferredCovidForAge(ageYears, covid);
      if (!choice) return { message: "No COVID vaccine under age 3." };
      return { codes: [choice.shortCode], label: choice.label };
    }
    return null;
  };
}

/** True when `shortCode` (a real dose row's MacroRow.shortCode) is one of
 * `codes` — tried verbatim first, then digit-stripped (macroBaseShortCode)
 * — same two-step resolution lib/macro-catalog.ts's lookupMacroCatalog
 * uses, so a multi-dose product's per-dose codes ("shingrix1"/
 * "shingrix2") match a base-keyed hotkey ("shingrix") the same way they
 * resolve to their catalog entry. Case-insensitive; false for null/empty. */
function shortCodeMatchesHotkeyCodes(shortCode: string | null, codes: readonly string[]): boolean {
  if (!shortCode) return false;
  const lower = shortCode.trim().toLowerCase();
  if (!lower) return false;
  if (codes.includes(lower)) return true;
  const base = macroBaseShortCode(lower);
  return base !== lower && codes.includes(base);
}

/**
 * Reverse lookup: given a catalog short code (exact or digit-stripped
 * base — see shortCodeMatchesHotkeyCodes above), returns the lowercase
 * hotkey letter/digit that selects it, or null when no hotkey covers it.
 * Used by the page to decide, for an already-known product, which key to
 * underline in its rendered name (underlineHotkey below) — the actual
 * "which product does THIS keypress select" direction is
 * resolveHotkeyTarget's job, not this function's.
 */
export function hotkeyForProduct(baseKey: string, map: HotkeyMap = MACRO_HOTKEYS): string | null {
  const lower = (baseKey ?? "").trim().toLowerCase();
  if (!lower) return null;
  for (const [key, codes] of Object.entries(map)) {
    if (shortCodeMatchesHotkeyCodes(lower, codes)) return key;
  }
  return null;
}

/** One dose-button target a hotkey resolves to: the product it belongs
 * to (for display/underline purposes) and its dose-1 row (lowest dose
 * number) — the same row/label handleCopy needs to act exactly like a
 * click on that product's first dose button. */
export type MacroHotkeyTarget = {
  product: MacroProductGroup;
  row: MacroRow;
};

/**
 * Resolves a pressed key to the dose-1 row of the FIRST VISIBLE product
 * it selects, walking `visibleTopGroups` in the same group -> section ->
 * product order the page renders them in — a product hidden by the
 * current age/search filter (i.e. not present in `visibleTopGroups` at
 * all) is never returned. Returns null when the key has no hotkey
 * mapping, or no visible product matches it. Case-insensitive.
 */
export function resolveHotkeyTarget(
  key: string,
  visibleTopGroups: readonly MacroTopGroupBlock[],
  map: HotkeyMap = MACRO_HOTKEYS
): MacroHotkeyTarget | null {
  const lowerKey = (key ?? "").trim().toLowerCase();
  const codes = map[lowerKey];
  if (!codes || codes.length === 0) return null;
  return resolveTargetForCodes(codes, visibleTopGroups);
}

/** The dose-1 row of the first visible product whose short code is one of `codes` (same walk as resolveHotkeyTarget), or null. */
export function resolveTargetForCodes(
  codes: readonly string[],
  visibleTopGroups: readonly MacroTopGroupBlock[]
): MacroHotkeyTarget | null {
  for (const block of visibleTopGroups) {
    for (const section of block.sections) {
      for (const product of section.products) {
        const matchingDose = lowestDoseNumberMatch(product.doses, codes);
        if (matchingDose) return { product, row: matchingDose.row };
      }
    }
  }
  return null;
}

/** Returns the lowest-dose-number MacroDoseButton among `doses` whose row
 * matches `codes`, or undefined when none do. A product's `doses` array
 * is already dose-number ordered (lib/macro-codes.ts's
 * groupMacroRowsBySection), but this doesn't rely on that — it picks the
 * minimum explicitly. */
function lowestDoseNumberMatch(
  doses: readonly MacroDoseButton[],
  codes: readonly string[]
): MacroDoseButton | undefined {
  let best: MacroDoseButton | undefined;
  for (const dose of doses) {
    if (!shortCodeMatchesHotkeyCodes(dose.row.shortCode, codes)) continue;
    if (!best || dose.row.doseNumber < best.row.doseNumber) best = dose;
  }
  return best;
}

/** The first case-insensitive occurrence of `key` split out of
 * `displayName` for underlining, e.g. underlineHotkey("Flucelvax", "f")
 * -> { before: "", letter: "F", after: "lucelvax" } (the ORIGINAL
 * casing/character is kept in `letter` — only the search is case-
 * insensitive). Returns null when `key` doesn't appear in `displayName`
 * at all (page.tsx falls back to a small "[F]"-style badge in that
 * case) or when `key` is empty. */
export function underlineHotkey(displayName: string, key: string): { before: string; letter: string; after: string } | null {
  const lowerKey = (key ?? "").trim().toLowerCase();
  if (!lowerKey) return null;
  const index = displayName.toLowerCase().indexOf(lowerKey);
  if (index === -1) return null;
  return {
    before: displayName.slice(0, index),
    letter: displayName.slice(index, index + lowerKey.length),
    after: displayName.slice(index + lowerKey.length),
  };
}

/**
 * ROUND 2 (Will's verbatim answer, 2026-09-28): "Multi-dose vaccines need
 * a second key press for the dose." Pressing a multi-dose product's
 * letter (Shingrix, Gardasil, Engerix, Vaqta, MMR, or any other product
 * whose visible dose count is > 1 — this is derived from
 * MacroProductGroup.doses.length, not a hardcoded product list) no
 * longer copies immediately; it "arms" that product, and a following
 * digit keypress (1/2/3…) copies that specific dose the same way
 * clicking its button would. A single-dose product's letter still copies
 * on the one press, unchanged from round 1. `armedProductKey` is the
 * only piece of state this needs — everything else (which product's row
 * to highlight, which other rows to dim, which digit maps to which dose)
 * is derived from it plus the current `visibleTopGroups` by the page.
 */
export type HotkeyState = { armedProductKey: string | null };

export const INITIAL_HOTKEY_STATE: HotkeyState = { armedProductKey: null };

/**
 * What the page should DO in response to a keypress, on top of adopting
 * the returned `state` (the page always does `setHotkeyState(result.state)`
 * unconditionally — `state` already reflects every case below, including
 * "no change"). `copy` is the only action that has a further side effect
 * (call the same `handleCopy(row, label)` a dose-button click calls);
 * `arm`/`clear`/`none` are informational only (arm/clear exist mainly so
 * this reducer's own tests can assert on them precisely).
 */
export type HotkeyAction =
  | { type: "copy"; product: MacroProductGroup; row: MacroRow }
  | { type: "arm"; product: MacroProductGroup }
  | { type: "clear" }
  | { type: "notice"; message: string }
  | { type: "none" };

export type HotkeyTransitionResult = { state: HotkeyState; action: HotkeyAction };

/**
 * Finds the currently-armed product by productKey within
 * `visibleTopGroups`, walking the same block -> section -> product order
 * resolveHotkeyTarget uses. Returns null when that product isn't in the
 * visible set at all (e.g. armed, then a search/age filter change hid
 * it).
 *
 * ROUND 2 FOLLOW-UP (reviewer, code review on 5a39605): this is now the
 * PRIMARY way armed state gets cleared by a visibility change, not a
 * defensive fallback — app/macro-codes/page.tsx calls this directly
 * (instead of clearing on every `visibleTopGroups` reference change) so
 * arming survives a background refetch that rebuilds the same visible
 * rows with new array/object identities (the 60s heartbeat, window
 * focus/visibilitychange — exactly the alt-tab-to-desktop-app workflow
 * this hotkey feature is FOR) and only clears when the armed product is
 * genuinely no longer among the visible ones (a real age-filter/search
 * change, or the product's own row disappearing). Exported so the page
 * can reuse the identical lookup instead of a second hand-rolled walk
 * that could drift from this one; also used internally by
 * hotkeyTransition's digit-dose-select branch above.
 */
export function findArmedProduct(
  armedProductKey: string,
  visibleTopGroups: readonly MacroTopGroupBlock[]
): MacroProductGroup | null {
  for (const block of visibleTopGroups) {
    for (const section of block.sections) {
      for (const product of section.products) {
        if (product.productKey === armedProductKey) return product;
      }
    }
  }
  return null;
}

/** Resolves a vaccine-letter (or the digit "3", which doubles as
 * Moderna 3-11's key when nothing is armed) keypress to its target
 * product via resolveHotkeyTarget, then decides arm vs. copy from that
 * product's own dose count — shared by both the "nothing armed yet" and
 * "re-arm to a different product while already armed" paths below, so
 * they can never disagree about which products are multi-dose. */
function armOrCopyForLetter(
  state: HotkeyState,
  lowerKey: string,
  visibleTopGroups: readonly MacroTopGroupBlock[],
  context: HotkeyContext
): HotkeyTransitionResult {
  // A smart key (flu2: F, C) resolves per patient: either to short codes
  // that then go through the same arm-or-copy path as a fixed letter, or
  // to a message ("needs the patient's age") shown without changing state.
  let target: MacroHotkeyTarget | null;
  const smart = context.smart?.(lowerKey) ?? null;
  if (smart) {
    if ("message" in smart) return { state, action: { type: "notice", message: smart.message } };
    target = resolveTargetForCodes(smart.codes, visibleTopGroups);
    if (!target) return { state, action: { type: "notice", message: `${smart.label} isn't on the list right now.` } };
  } else {
    target = resolveHotkeyTarget(lowerKey, visibleTopGroups, context.map ?? MACRO_HOTKEYS);
  }
  // An unmapped key, or a mapped key whose product is currently hidden
  // by a filter, changes nothing — in particular it does NOT clear an
  // existing armed state (only Escape, a successful dose copy, or the
  // page's own visibleTopGroups-changed effect do that).
  if (!target) return { state, action: { type: "none" } };
  if (target.product.doses.length > 1) {
    return { state: { armedProductKey: target.product.productKey }, action: { type: "arm", product: target.product } };
  }
  return { state: { armedProductKey: null }, action: { type: "copy", product: target.product, row: target.row } };
}

/**
 * Pure keypress -> (next state, action) transition for the armed-mode
 * hotkey flow. `key` is whatever `KeyboardEvent.key` gives the page
 * (case-insensitive letters/digits, plus the literal "Escape" — this
 * function lowercases internally so either "Escape" or "escape" works).
 *
 * Order of precedence, matching Will's verbatim brief:
 * 1. Escape always clears armed state (and does nothing else — the page
 *    is responsible for NOT letting its embed-cancel/modal-close Escape
 *    handlers also fire while a product is armed).
 * 2. While a product is armed, any single digit is read as a DOSE
 *    NUMBER first — this is what makes "3" mean "dose 3 of the armed
 *    product" instead of Moderna 3-11 while armed, per Will's note.
 *    A digit that isn't any of the armed product's dose numbers does
 *    nothing (stays armed, `action: "none"`). A digit while the armed
 *    product is no longer visible (filtered out since arming) clears
 *    instead of leaving a dangling reference.
 * 3. Otherwise (not armed, or armed but the key isn't a bare digit) the
 *    key is resolved as a vaccine letter/hotkey via armOrCopyForLetter
 *    above — this also covers "3" when nothing is armed (Moderna) and
 *    re-arming to a different product while one is already armed.
 * 4. An unmapped key changes nothing (`state` unchanged, `action: "none"`).
 */
export function hotkeyTransition(
  state: HotkeyState,
  key: string,
  visibleTopGroups: readonly MacroTopGroupBlock[],
  context: HotkeyContext = {}
): HotkeyTransitionResult {
  const lowerKey = (key ?? "").trim().toLowerCase();
  if (!lowerKey) return { state, action: { type: "none" } };

  if (lowerKey === "escape") {
    if (state.armedProductKey === null) return { state, action: { type: "none" } };
    return { state: { armedProductKey: null }, action: { type: "clear" } };
  }

  const isSingleDigit = /^[0-9]$/.test(lowerKey);

  if (state.armedProductKey !== null && isSingleDigit) {
    const product = findArmedProduct(state.armedProductKey, visibleTopGroups);
    if (!product) return { state: { armedProductKey: null }, action: { type: "clear" } };
    const doseNumber = Number(lowerKey);
    const dose = product.doses.find((d) => d.row.doseNumber === doseNumber);
    if (!dose) return { state, action: { type: "none" } };
    return { state: { armedProductKey: null }, action: { type: "copy", product, row: dose.row } };
  }

  return armOrCopyForLetter(state, lowerKey, visibleTopGroups, context);
}

/** The armed-mode hint text shown near the highlighted row/page header
 * (Will's verbatim wording, N = the armed product's own dose count). */
export function armedHotkeyNote(doseCount: number): string {
  return `Press 1–${doseCount} for the dose · Esc to clear`;
}

/** What app/macro-codes/page.tsx's embed-cancel Escape listener should do
 * on an Escape keypress, extracted to a pure function so this decision
 * (V-T64: "Escape is still closing the full window, not backing out of
 * Shingrix") has its own direct test coverage rather than only being
 * exercised through a mounted document keydown listener.
 *
 * "post-cancel" posts vaccine-assist:macro-cancel and closes the embed
 * popup (the second-Escape / nothing-armed case). "none" means this
 * listener has nothing to do — either the lot/exp modal or a ⚙ menu
 * already owns Escape for their own narrower close (see the modal-close
 * and menu-close effects in page.tsx), or a product is currently armed,
 * in which case the SEPARATE hotkeys keydown effect (hotkeyTransition
 * above) owns this same keypress and clears the armed state instead —
 * this function must never also post macro-cancel on that same keypress,
 * which is exactly the invariant this pure split makes testable: exactly
 * one component decides what Escape does, from the CURRENT armed state
 * (armedProductKey is read fresh by the caller on every call, not cached). */
export function decideEmbedEscape(input: {
  modalOpen: boolean;
  anyMenuOpen: boolean;
  armedProductKey: string | null;
}): "post-cancel" | "none" {
  if (input.modalOpen || input.anyMenuOpen || input.armedProductKey) return "none";
  return "post-cancel";
}
