/**
 * V-macro-age-filter (Will's verbatim ask, 2026-09-25): the desktop
 * app's new Ctrl+Numpad4 flow asks a patient's age BEFORE opening
 * /macro-codes, then opens it filtered to only the vaccines that age is
 * eligible for. This file is the pure parsing/matching half of that:
 * turning a catalog age-range label (lib/macro-catalog.ts's
 * MacroCatalogEntry.age / lib/macro-codes.ts's MacroRow.age /
 * MacroProductGroup.age) into structured ranges, and answering whether
 * a given age falls in ANY of them.
 *
 * Label formats seen in the real catalog today (lib/macro-catalog.ts):
 * "12+", "3–11" (en dash), "6 mo+", "2 mo–55", "50+ (19+ IC)", "60+
 * (50–59 high-risk)", "" (unrecognized short code). The qualifier
 * clause in parens (or, per the brief, sometimes a comma clause like
 * "75+, 18+ high-risk") is itself always another age token — "50+ (19+
 * IC)" means "50 and up, OR 19 and up if immunocompromised" — so
 * parseAgeRange doesn't try to understand the qualifier's WORDING at
 * all, it just extracts every age token in the string as its own
 * range, in order. That keeps this parser generic across "(...)",
 * ", ..." and any other punctuation Will's actual data uses to join
 * clauses, without hand-listing separators.
 *
 * A token is either:
 *   - a plus form: NUMBER[UNIT]+ (e.g. "12+", "6 mo+") -> {minYears,
 *     maxYears: null}
 *   - a range form: NUMBER[UNIT]-NUMBER[UNIT] (ASCII hyphen or en dash;
 *     e.g. "3–11", "2 mo–55", and the months-shorthand "6m–11" some
 *     desktop-side callers may pass) -> {minYears, maxYears}
 * UNIT is optional and is either "mo" or a bare "m" (no space needed,
 * e.g. "6m") meaning months — converted to years (÷12). No unit means
 * years. Anything in the label that isn't part of a token (words like
 * "high-risk", "IC", punctuation) is ignored.
 */

export type AgeRange = { minYears: number; maxYears: number | null };

const AGE_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(mo|m)?(?:\s*[-–]\s*(\d+(?:\.\d+)?)\s*(mo|m)?)?(\s*\+)?/g;

function toYears(value: number, unit: string | undefined): number {
  return unit === "mo" || unit === "m" ? value / 12 : value;
}

/**
 * Parses every age token out of a catalog age-range label, in the
 * order they appear (a qualifier clause's token, e.g. "50+ (19+ IC)"'s
 * "19+", comes after the primary one). Returns `[]` for an empty or
 * unparseable label ("" for an unrecognized short code, or any text
 * with no recognizable age token) — callers treat that as "unknown,
 * never excluded" (see ageRangeIncludes below).
 */
export function parseAgeRange(label: string): AgeRange[] {
  const ranges: AgeRange[] = [];
  for (const match of label.matchAll(AGE_TOKEN_RE)) {
    const [, minRaw, minUnit, maxRaw, maxUnit, plus] = match;
    if (minRaw === undefined) continue;
    const minYears = toYears(Number(minRaw), minUnit);
    if (maxRaw !== undefined) {
      ranges.push({ minYears, maxYears: toYears(Number(maxRaw), maxUnit) });
    } else if (plus !== undefined) {
      ranges.push({ minYears, maxYears: null });
    }
    // A bare number with neither a range nor a trailing "+" isn't a
    // real age token in any label seen so far — skipped rather than
    // guessed at.
  }
  return ranges;
}

/**
 * True when `ageYears` falls in ANY of `label`'s parsed ranges
 * (inclusive at both ends). An empty or unparseable label (parses to
 * `[]`) always returns true — an unrecognized/unknown product is never
 * hidden by an age filter, it just isn't a confirmed match either (see
 * lib/macro-codes.ts's filterMacroProductsByAge, which uses that
 * distinction to list unknowns last rather than mixed in with real
 * matches).
 */
export function ageRangeIncludes(label: string, ageYears: number): boolean {
  const ranges = parseAgeRange(label);
  if (ranges.length === 0) return true;
  return ranges.some((range) => ageYears >= range.minYears && (range.maxYears === null || ageYears <= range.maxYears));
}
