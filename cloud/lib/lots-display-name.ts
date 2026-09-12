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
 * leaving everything else (season outside parens, dose-form qualifiers
 * like "MDV", "PFS", "HD", "adult", "two-vial", pack-count "1 ct", and
 * plain product numbers like "Prevnar 20") untouched.
 *
 * Round 4 tried to detect just the age-shaped content of a
 * parenthetical and strip only that, which left fragments whenever a
 * parenthetical held MORE than an age expression — "(6 mo+;
 * immunocompromised)" -> "(; immunocompromised)", "(2 mo-55 yr)" ->
 * "( yr)", "(...pregnancy 32-36 wk)" -> "(; pregnancy wk)".
 *
 * Round 5's first pass over-corrected the other way: it deleted every
 * parenthetical outright. That collapsed distinct catalog SKUs onto
 * the same /lots name — "Abrysvo" and "Abrysvo (1 ct)" both became
 * "Abrysvo"; "Flucelvax (2026-27, PFS)" and "Flucelvax (2026-27,
 * MDV)" both became "Flucelvax" — which is exactly the ambiguity
 * /lots exists to prevent (see lib/vaccine-product-catalog.ts, e.g.
 * the Afluria PFS/MDV and Flucelvax PFS/MDV pairs, and the Abrysvo
 * 10-count/1-count pair).
 *
 * Round 5's fix (this version) parses each parenthetical's content
 * instead of deleting it wholesale: split on ";" and "," into
 * segments, classify each segment as NOISE (age ranges/tokens,
 * "high-risk", "immunocompromised", "pregnancy ... wk", a bare season
 * like "2026-27" — redundant once it's inside parens, since a season
 * that matters is always ALSO in the base name outside parens, e.g.
 * "Spikevax 2026-27 (...)") and drop it, or else conservatively KEEP
 * it (SKU qualifiers like "PFS", "MDV", "HD", "adult", "two-vial",
 * "1 ct", "20 mcg" all fall through to this default — anything NOT
 * recognized as noise survives, so an unanticipated future qualifier
 * is never silently swallowed the way round 5's first pass swallowed
 * all of them). Kept segments are appended, space-joined, after the
 * cleaned base name. A nested parenthetical ("Capvaxive (18+ (2-17
 * high-risk))") is flattened one level so its content becomes its own
 * segment(s) rather than merging into the surrounding text — see
 * flattenNestedParens.
 *
 * What's left outside the parentheses then goes through the same
 * age-token stripping as before (12+, 6mo-11, 3-4, 65+, etc. — a
 * 4-digit season like the "2026" in "2026-27" never matches, since
 * every pattern below caps at 3 digits), plus removal of the
 * standalone word "Formula", then whitespace/punctuation cleanup.
 */

const FORMULA_WORD = /\bformula\b/gi;
const PLUS_TOKEN = /\s*\b\d{1,3}(?:mo|yr)?(?:[-–]\d{1,3}(?:mo|yr)?)?\+/g;
const MO_YR_TOKEN = /\s*\b\d{1,3}(?:mo|yr)(?:[-–]\d{1,3}(?:mo|yr)?)?\b/gi;
const RANGE_TOKEN = /\s*\b\d{1,3}[-–]\d{1,3}\b/g;
const TRAILING_PUNCT = /[\s;,\-–]+$/;

// A bare "2026-27" / "2026-2027" style season, as a WHOLE segment.
const SEASON_SEGMENT = /^\d{4}-\d{2,4}$/;
// A bare eligibility-note word, as a WHOLE segment (no leading age token).
const BARE_ELIGIBILITY_SEGMENT = /^(?:high-risk|immunocompromised)$/i;
// A bare "pregnancy ... wk" phrase, as a WHOLE segment.
const PREGNANCY_SEGMENT = /^pregnancy\b.*\bwk$/i;
// An age expression, optionally led by "age " and/or trailing an
// eligibility note — "60+", "18+; " (semicolon split off first), "2
// mo-55 yr", "10-25 yr", "2+ yr", "19+ immunocompromised",
// "2-17 high-risk", "age 20+". Anchored: must consume the WHOLE
// (trimmed) segment to count as noise.
const AGE_EXPR_SEGMENT =
  /^(?:age\s+)?\d{1,3}(?:\s?(?:mo|yr))?(?:\s?[-–]\s?\d{1,3}(?:\s?(?:mo|yr))?)?\+?(?:\s?(?:mo|yr))?(?:\s+(?:high-risk|immunocompromised))?$/i;

function isNoiseSegment(segment: string): boolean {
  if (SEASON_SEGMENT.test(segment)) return true;
  if (BARE_ELIGIBILITY_SEGMENT.test(segment)) return true;
  if (PREGNANCY_SEGMENT.test(segment)) return true;
  if (AGE_EXPR_SEGMENT.test(segment)) return true;
  return false;
}

/** Converts any parens NESTED inside an already-extracted group's
 * content into segment splitters, so "18+ (2-17 high-risk)" becomes
 * "18+ ;2-17 high-risk;" — the inner content is then classified as its
 * own segment(s) by the "," / ";" split below, instead of merging with
 * the surrounding text into one unclassifiable blob. */
function flattenNestedParens(content: string): string {
  return content.replace(/[()]/g, ";");
}

/** Depth-tracked scan of the whole display name: returns the text
 * outside any top-level "(...)" group (`base`) and the raw content of
 * each top-level group (`groups`, in order). A group that never closes
 * (a dangling "(") is discarded entirely, along with whatever followed
 * it — there's no matching close to resume the base text at. */
function extractParenGroups(input: string): { base: string; groups: string[] } {
  let base = "";
  let current = "";
  let depth = 0;
  const groups: string[] = [];
  for (const ch of input) {
    if (ch === "(") {
      depth++;
      if (depth > 1) current += ch;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          groups.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
      continue;
    }
    if (depth === 0) base += ch;
    else current += ch;
  }
  return { base, groups };
}

/** Strips qualifier/noise tokens from a /lots product display name —
 * see this file's header for exactly what counts as one. Pure/no I/O. */
export function lotsDisplayName(displayName: string): string {
  const { base, groups } = extractParenGroups(displayName);

  const kept: string[] = [];
  for (const group of groups) {
    for (const raw of flattenNestedParens(group).split(/[;,]/)) {
      const segment = raw.trim();
      if (!segment) continue;
      if (!isNoiseSegment(segment)) kept.push(segment);
    }
  }

  let result = base.replace(FORMULA_WORD, "");
  result = result.replace(PLUS_TOKEN, "");
  result = result.replace(MO_YR_TOKEN, "");
  result = result.replace(RANGE_TOKEN, "");
  result = result.replace(/\s{2,}/g, " ").trim();
  result = result.replace(TRAILING_PUNCT, "").trim();

  if (kept.length > 0) {
    result = `${result} ${kept.join(" ")}`.replace(/\s{2,}/g, " ").trim();
  }

  return result;
}
