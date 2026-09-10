/**
 * Shared NDC (National Drug Code) normalization — V-ordering-targets
 * (Will 2026-09-08). An NDC can arrive dashed ("0006-4347-02"), undashed
 * ("00064347-02" from a Pioneer export's "NDC/UPC" column, digits only),
 * or null (`vaccine.ndc` is nullable — see supabase/migrations/0001_init.sql).
 * Every place that compares two NDCs (on-hand upload matching, the
 * ordering recommendation's NDC-collapse, ordering_target's `key`) does
 * it on the DIGITS-ONLY form so a dashed catalog value and an undashed
 * Pioneer export value compare equal.
 */
export function normalizeNdc(value: string | null | undefined): string | null {
  if (!value) return null;
  // A catalog row can carry more than one NDC in a single comma-separated
  // field (e.g. seed data's "00005-2000-10, 00005-2000-02" for a
  // multi-pack) — take only the FIRST one rather than concatenating every
  // digit across all of them into one meaningless string.
  const first = value.split(",")[0] ?? value;
  const digits = first.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Validates and formats a manually-entered NDC for storage on
 * vaccine.ndc (PATCH /api/vaccines/[id]'s `ndc` field,
 * V-onhand-pioneer-ndc-match, Will 2026-09-09 4:31pm: "so I can persist
 * the researched package NDCs via the API"). Accepts 10 or 11 digits,
 * dashed or not.
 *
 * A 10-digit input is left-padded with one leading zero to the standard
 * 11-digit NDC-11 billing form before formatting. This app has no
 * reliable way to tell WHICH of the three segments (labeler/product/
 * package) is short from the digits alone — a leading-zero pad is only
 * correct when the labeler-code segment is the short one, the most
 * common real-world case, but not the only one (5-3-2 and 5-4-1 formats
 * also exist). Documented judgment call, not a guaranteed-correct FDA
 * NDC-11 conversion — same "prototype vs production balance" posture as
 * this app's other documented tradeoffs (see e.g.
 * app/api/ordering/recommendation/route.ts's COMPOSITE_BASE_TO_CATALOG_NAME
 * comment).
 *
 * Returns the digits formatted 5-4-2 ("58160-0821-52"), or null if the
 * input isn't 10-11 digits once dashes/whitespace are stripped.
 */
export function formatNdcForStorage(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10 && digits.length !== 11) return null;
  const eleven = digits.length === 10 ? `0${digits}` : digits;
  return `${eleven.slice(0, 5)}-${eleven.slice(5, 9)}-${eleven.slice(9)}`;
}

/**
 * Display-formats an NDC as "XXXXX-XXXX-XX" (5-4-2, dashed) — used for
 * EVERY NDC shown on the Ordering and Lots pages (V-T-ordering-lots-
 * round4, Will: "Make the NDCs follow this format: XXXXX-XXXX-XX") so the
 * same product's NDC renders identically on both screens. Digits are
 * extracted from whatever form the value arrives in (already-dashed or
 * not) — a 10-digit result is left-padded with one leading zero first,
 * the same documented judgment call formatNdcForStorage above makes (not
 * a guaranteed-correct FDA NDC-11 conversion, just the common labeler-
 * code-is-short case). Anything else (not 10 or 11 digits once
 * non-digits are stripped) is returned UNCHANGED rather than guessed at —
 * same "don't silently mis-segment" posture as lib/lots-grouping.ts's
 * formatNdcDisplay. Null/undefined -> "" (callers that want a "—"
 * placeholder for a missing NDC add that themselves, same as they already
 * do for formatNdcDisplay).
 */
export function formatNdcDashed(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11) {
    return `${digits.slice(0, 5)}-${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 10) {
    const eleven = `0${digits}`;
    return `${eleven.slice(0, 5)}-${eleven.slice(5, 9)}-${eleven.slice(9)}`;
  }
  return value;
}
