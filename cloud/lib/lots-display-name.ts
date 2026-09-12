/**
 * /lots-only product name shortener (V-T-lots-round4/round5, Will
 * verbatim round5: "The helper text MM/DD/YYYY is being cut off
 * slightly. There is still a lot of random text there. Ex: (;
 * immunocompromised), (2 mo-55 yr), ( yr), (; pregnancy wk), (;
 * high-risk), 'Formula'. Get rid of those and others.") —
 * lib/product-view.ts's `displayName` is SHARED with /ordering and
 * /macro-codes (see that file's header: "the ONE place that computes
 * those four fields"), so it can't be changed there without altering
 * output those pages depend on. This is a separate pure helper,
 * applied ONLY on /lots (app/lots/page.tsx), that strips
 * qualifier/noise tokens from an already-computed displayName while
 * leaving everything else (season, dose-form qualifiers like "MDV",
 * "PFS", "HD", "adult", and plain product numbers like "Prevnar 20")
 * untouched.
 *
 * Round 4 tried to detect just the age-shaped content of a
 * parenthetical and strip only that, which left fragments whenever a
 * parenthetical held MORE than an age expression — "(6 mo+;
 * immunocompromised)" -> "(; immunocompromised)", "(2 mo-55 yr)" ->
 * "( yr)", "(...pregnancy 32-36 wk)" -> "(; pregnancy wk)". Round 5
 * drops the detection step entirely: EVERY parenthetical is removed,
 * unconditionally, whatever it contains (including nested groups and
 * a dangling unclosed "(" — see stripAllParens below), plus the
 * standalone word "Formula". What's left then goes through the same
 * outside-of-parens age-token stripping as before:
 *   - a bare number immediately followed by "+" — "12+", "65+", "50+",
 *     "6mo+"
 *   - a number carrying "mo"/"yr", alone or as one side of a range —
 *     "6mo-11", "6mo", "2yr-4yr"
 *   - a plain small-number range with a "-"/"–" — "3-4", "5-11"
 * A 4-digit number (a season year, e.g. the "2026" in "2026-27") never
 * matches any of these — every pattern below caps at 3 digits — so
 * "2026-27" survives untouched.
 */

const FORMULA_WORD = /\bformula\b/gi;
const PLUS_TOKEN = /\s*\b\d{1,3}(?:mo|yr)?(?:[-–]\d{1,3}(?:mo|yr)?)?\+/g;
const MO_YR_TOKEN = /\s*\b\d{1,3}(?:mo|yr)(?:[-–]\d{1,3}(?:mo|yr)?)?\b/gi;
const RANGE_TOKEN = /\s*\b\d{1,3}[-–]\d{1,3}\b/g;
const TRAILING_PUNCT = /[\s;,\-–]+$/;

/** Removes every parenthetical group from a string, including nested
 * ones ("a (b (c) d) e" -> "a  e") and a dangling unclosed "(" (which,
 * once opened, drops everything through the end of the string, since
 * there's no matching close to resume at). Pure string scan, no
 * backtracking regex needed for the nested case. */
function stripAllParens(input: string): string {
  let out = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/** Strips qualifier/noise tokens from a /lots product display name —
 * see this file's header for exactly what counts as one. Pure/no I/O. */
export function lotsDisplayName(displayName: string): string {
  let result = stripAllParens(displayName);
  result = result.replace(FORMULA_WORD, "");
  result = result.replace(PLUS_TOKEN, "");
  result = result.replace(MO_YR_TOKEN, "");
  result = result.replace(RANGE_TOKEN, "");
  result = result.replace(/\s{2,}/g, " ").trim();
  result = result.replace(TRAILING_PUNCT, "").trim();
  return result;
}
