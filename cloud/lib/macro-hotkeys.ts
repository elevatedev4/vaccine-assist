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
 * letter: he originally wrote "U" for both FluMist and Fluad (Fluad gets
 * "A" instead) and "P" for both Pfizer 12+ and Prevnar 20 (Prevnar gets
 * "N" instead) — MACRO_HOTKEYS below is that already-resolved, collision-
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
  a: ["fluad"],
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
export function hotkeyForProduct(baseKey: string): string | null {
  const lower = (baseKey ?? "").trim().toLowerCase();
  if (!lower) return null;
  for (const [key, codes] of Object.entries(MACRO_HOTKEYS)) {
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
  visibleTopGroups: readonly MacroTopGroupBlock[]
): MacroHotkeyTarget | null {
  const lowerKey = (key ?? "").trim().toLowerCase();
  const codes = MACRO_HOTKEYS[lowerKey];
  if (!codes || codes.length === 0) return null;

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
