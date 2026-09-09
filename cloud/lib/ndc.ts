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
