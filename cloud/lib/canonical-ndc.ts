/**
 * Canonical-NDC overrides (V-T66 round 2, Will 2026-09-30 1:16pm verbatim:
 * "This is the correct NDC for Shingrix: 58160084952. Don't list both.").
 *
 * A handful of products carry more than one NDC across their seeded dose
 * rows in production (the Shingrix case: dose 1 and dose 2 are seeded
 * with different NDCs). Two SEPARATE grouping pipelines each collapse a
 * product's dose rows into one row and each need to agree on which of
 * those NDCs is the PRIMARY one to display/key on — lib/lots-grouping.ts
 * (the /lots and /macro-codes tabs, via lib/product-view.ts) and
 * lib/ordering-ndc-collapse.ts (the /ordering tab, a deliberately
 * separate pipeline — see that file's own header comment for why it
 * isn't just imported from lots-grouping.ts). Without this map, BOTH
 * pick the lexicographically-SMALLEST of a product's recorded NDCs as
 * primary — for Shingrix that picks the wrong one ("58160082311" sorts
 * before "58160084952"). This map lets a specific product pin its
 * real/preferred NDC instead of relying on that alphabetical tie-break,
 * consulted identically by both pipelines.
 *
 * Keyed by a normalized product-name key: trimmed, lowercased, dose-
 * marker stripped. Each pipeline computes this key with its OWN local
 * function (lib/lots-grouping.ts's normalizeProductNameKey,
 * lib/ordering-ndc-collapse.ts's normalizeCollapseNameKey) rather than a
 * shared import — the two files are deliberately siblings, not one
 * importing the other (see lib/ordering-ndc-collapse.ts's header) — but
 * both normalize the same way, so a product's entry here resolves
 * identically regardless of which pipeline is asking.
 *
 * Both pipelines only apply an entry here when the canonical value is
 * actually one of the NDCs recorded on that product's own dose rows —
 * this map can never invent an NDC nobody seeded, so a future re-seed
 * (or a different product that happens to share a name key) can't
 * silently get mis-tagged with a stale value.
 */
export const CANONICAL_NDC: Record<string, string> = {
  shingrix: "58160084952",
};
