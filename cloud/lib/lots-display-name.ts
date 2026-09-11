/**
 * /lots-only product name shortener (V-T-lots-round4, Will verbatim:
 * "Remove all the extraneous info from drug name (ex: age range). Just
 * show the product.") — lib/product-view.ts's `displayName` is SHARED
 * with /ordering and /macro-codes (see that file's header: "the ONE
 * place that computes those four fields"), so it can't be changed there
 * without altering output those pages depend on. This is a separate
 * pure helper, applied ONLY on /lots (app/lots/page.tsx), that strips
 * age-qualifier tokens from an already-computed displayName while
 * leaving everything else (season, dose-form qualifiers like "MDV",
 * "PFS", "HD", "adult", and plain product numbers like "Prevnar 20")
 * untouched.
 *
 * What counts as an age qualifier, deliberately narrow so a bare
 * product number is never mistaken for one:
 *   - a parenthetical whose content is an age expression, with or
 *     without a literal "age" word — "(age 2-49)", "(age 20+)", "(19+)"
 *   - a bare number immediately followed by "+" — "12+", "65+", "50+",
 *     "6mo+"
 *   - a number carrying "mo"/"yr", alone or as one side of a range —
 *     "6mo-11", "6mo", "2yr-4yr"
 *   - a plain small-number range with a "-"/"–" — "3-4", "5-11"
 * A 4-digit number (a season year, e.g. the "2026" in "2026-27") never
 * matches any of these — every pattern below caps at 3 digits — so
 * "2026-27" survives untouched.
 */

const AGE_PAREN = /\s*\(([^()]*)\)/g;
const AGE_PAREN_CONTENT = /^(age\s+)?\d{1,3}(?:mo|yr)?(?:\s*[-–]\s*\d{1,3}(?:mo|yr)?)?\+?$/i;
const PLUS_TOKEN = /\s*\b\d{1,3}(?:mo|yr)?(?:[-–]\d{1,3}(?:mo|yr)?)?\+/g;
const MO_YR_TOKEN = /\s*\b\d{1,3}(?:mo|yr)(?:[-–]\d{1,3}(?:mo|yr)?)?\b/gi;
const RANGE_TOKEN = /\s*\b\d{1,3}[-–]\d{1,3}\b/g;

function isAgeParenContent(content: string): boolean {
  return AGE_PAREN_CONTENT.test(content.trim());
}

/** Strips age-qualifier tokens from a /lots product display name — see
 * this file's header for exactly what counts as one. Pure/no I/O. */
export function lotsDisplayName(displayName: string): string {
  let result = displayName.replace(AGE_PAREN, (match, inner: string) => (isAgeParenContent(inner) ? "" : match));
  result = result.replace(PLUS_TOKEN, "");
  result = result.replace(MO_YR_TOKEN, "");
  result = result.replace(RANGE_TOKEN, "");
  return result.replace(/\s{2,}/g, " ").trim();
}
