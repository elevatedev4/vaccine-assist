/**
 * Canonical-NDC overrides (V-T66 round 2, Will 2026-09-30 1:16pm verbatim:
 * "This is the correct NDC for Shingrix: 58160084952. Don't list both.").
 *
 * A handful of products carry more than one NDC across their seeded dose
 * rows in production (see lib/lots-grouping.ts's `altNdcs` — the Shingrix
 * case: dose 1 and dose 2 are seeded with different NDCs). Without this
 * map, lib/lots-grouping.ts picks the lexicographically-SMALLEST of a
 * product's recorded NDCs as the one PRIMARY NDC it displays everywhere
 * (Lots, Ordering, Macro codes) — for Shingrix that picks the wrong one
 * ("58160082311" sorts before "58160084952"). This map lets a specific
 * product pin its real/preferred NDC instead of relying on that
 * alphabetical tie-break.
 *
 * Keyed by the SAME normalized product-name key lib/lots-grouping.ts uses
 * internally for its own grouping (trimmed, lowercased, dose-marker
 * stripped — see that file's normalizeProductNameKey), so every dose row
 * sharing one product name resolves to the same override regardless of
 * which row's name display selection happens to keep.
 *
 * lib/lots-grouping.ts only applies an entry here when the canonical
 * value is actually one of the NDCs recorded on that product's own dose
 * rows — this map can never invent an NDC nobody seeded, so a future
 * re-seed (or a different product that happens to share a name key) can't
 * silently get mis-tagged with a stale value.
 */
export const CANONICAL_NDC: Record<string, string> = {
  shingrix: "58160084952",
};
