import { normalizeNdc, formatNdcForStorage } from "@/lib/ndc";
import { isKnownAltNdcForProduct, ndcBelongsToOtherProduct } from "@/lib/vaccine-product-catalog";
import type { MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * NDC reconciliation from the Pioneer report (V-onhand-ndc-units, Will
 * 2026-09-09/10 verbatim: "Some of the NDCs are wrong on the items (ex:
 * Fluad has an NDC from a previous year). You need to check and get the
 * correct NDC for every item. The BOH report I'm sending has the NDC in
 * the report.").
 *
 * The Pioneer report is treated as the source of truth for NDCs, but
 * which of a product's several report lines is trusted is decided by
 * STOCK, not by which matching pass found it (fix/ndc-adopt-in-stock,
 * Will 2026-09-10, real Pioneer noon report: Pioneer lists several
 * products under multiple NDCs — old package sizes/years alongside the
 * current one — and the old "exactly one distinct NDC among
 * non-exact-matched lines" rule adopted whichever stale/zero-stock NDC
 * happened to be the SOLE name-matched line, overwriting a correct,
 * in-stock ndc six times in one real run: Comirnaty, mNEXSPIKE, Prevnar
 * 20, and Shingrix all had their in-stock exact-ndc-matched line's report
 * NDC excluded from candidacy while a zero-stock name-matched line stood
 * alone and "won"; Fluad and Spikevax carried 3-4 distinct report NDCs
 * and were left unchanged entirely even though exactly one line actually
 * had stock).
 *
 * So: for each product, EVERY line in this batch is a candidate
 * (regardless of which of matchPioneerBohRows's four passes matched it —
 * MatchedOnHandRow.matchedByExactNdc no longer excludes a line, it's
 * informational only now), and the line with the HIGHEST doses
 * (`quantity`) wins — that's the package Pioneer actually has on the
 * shelf right now, which is the whole point of trusting this report.
 *
 *   - If the highest quantity across a product's lines is 0 or null,
 *     nothing is adopted (`skipped` reason "no-stock") — no line has any
 *     stock, so there's no report-confirmed "current" NDC to prefer.
 *   - If two or more lines tie for that highest quantity but disagree on
 *     NDC, nothing is adopted (`skipped` reason "tie") — no principled
 *     way to prefer one over the other.
 *   - Otherwise the single highest-quantity line's NDC is the candidate.
 *     If it's already what's on file (digits-only), nothing to do.
 *
 * The candidate then still runs the same three adoption guards as
 * before (review fix, reviewer repro: Abrysvo's 10-count row, ndc
 * "00069-2465-10", almost got silently overwritten to "00069-2465-01" —
 * the SEPARATE 1-count product's own NDC — by a report line carrying
 * that NDC, which resolved to the 10-count row only because it's listed
 * as an altNdc there purely for on-hand-matching purposes, not because
 * it's ever a valid NDC for that row):
 *
 *   1. Known-altNdc guard (isKnownAltNdcForProduct): a candidate NDC
 *      that's a recognized ALT ndc (lib/vaccine-product-catalog.ts's
 *      ProductCatalogMatch.altNdcs) for the SAME product is never
 *      adopted — an altNdc is a known old/variant identifier tolerated
 *      for MATCHING, never the product's real/current NDC.
 *   2a. Same-batch/DB-ownership guard: a candidate NDC that's already
 *      on file as some OTHER vaccine row's own ndc is never adopted —
 *      it identifies a different product in THIS account's own catalog.
 *   2b. Other-product guard (ndcBelongsToOtherProduct): a candidate NDC
 *      that's the primary or an alt NDC of a DIFFERENT product in the
 *      static research catalog is never adopted, even if no DB row
 *      currently holds it.
 *   3. Cross-batch dedupe: after every other guard, if the SAME
 *      candidate NDC would end up adopted onto more than one vaccine row
 *      in this one decision pass (two different products both winning
 *      with a line that happens to carry the same report NDC), NONE of
 *      them are adopted — one NDC is never written to two rows.
 *
 * Any row/product tripping a guard is returned in `skipped` rather than
 * silently dropped, so the caller can log exactly why nothing was
 * adopted.
 *
 * Pure and side-effect-free — lib/on-hand/insert.ts is what actually
 * writes the adoptions to Supabase and logs them.
 */

export type NdcAdoption = {
  vaccineId: string;
  vaccineName: string;
  /** The vaccine's ndc on file BEFORE this adoption — null when it had
   * none at all. */
  oldNdc: string | null;
  /** The report's NDC, formatted for storage (lib/ndc.ts's
   * formatNdcForStorage — dashed 5-4-2). */
  newNdc: string;
};

export type NdcSkipReason =
  /** The candidate NDC is a known altNdc for the SAME product — not a
   * correction, a recognized old/variant identifier. */
  | "alt-ndc"
  /** The candidate NDC already belongs to a DIFFERENT product — either
   * another vaccine row's own on-file ndc, or a different product
   * entirely in the static research catalog. */
  | "other-product"
  /** The candidate NDC would have been adopted onto more than one
   * vaccine row in this same decision pass. */
  | "duplicate-in-batch"
  /** No line for this product carried any stock (highest quantity was 0
   * or null) — nothing in the report confirms a "current" NDC. */
  | "no-stock"
  /** Two or more lines tied for the highest quantity but disagreed on
   * NDC — no principled way to prefer one. */
  | "tie";

export type NdcSkip = {
  vaccineId: string;
  vaccineName: string;
  /** The (normalized, digits-only) candidate NDC that was NOT adopted —
   * for "tie" this is the tied NDCs joined with ", "; for "no-stock"
   * there's no candidate at all, so this is "". */
  ndc: string;
  reason: NdcSkipReason;
};

export type NdcReconciliationResult = {
  adoptions: NdcAdoption[];
  skipped: NdcSkip[];
};

export function decideNdcAdoptions(rows: MatchedOnHandRow[], catalog: CatalogVaccine[]): NdcReconciliationResult {
  type Line = { ndc: string; quantity: number };
  const linesByVaccine = new Map<string, Line[]>();

  for (const row of rows) {
    if (!row.vaccineId) continue;
    const normalized = normalizeNdc(row.ndc);
    if (!normalized) continue;

    const list = linesByVaccine.get(row.vaccineId) ?? [];
    list.push({ ndc: normalized, quantity: row.quantity ?? 0 });
    linesByVaccine.set(row.vaccineId, list);
  }

  const skipped: NdcSkip[] = [];
  const candidates: NdcAdoption[] = [];

  for (const [vaccineId, lines] of linesByVaccine) {
    const vaccine = catalog.find((candidate) => candidate.id === vaccineId);
    if (!vaccine) continue; // shouldn't happen (vaccineId came from this same catalog), but nothing to reconcile against

    const maxQuantity = Math.max(...lines.map((line) => line.quantity));
    if (maxQuantity <= 0) {
      skipped.push({ vaccineId, vaccineName: vaccine.name, ndc: "", reason: "no-stock" });
      continue;
    }

    const winnerNdcs = [...new Set(lines.filter((line) => line.quantity === maxQuantity).map((line) => line.ndc))];
    if (winnerNdcs.length > 1) {
      skipped.push({ vaccineId, vaccineName: vaccine.name, ndc: winnerNdcs.join(", "), reason: "tie" });
      continue;
    }

    const reportNdc = winnerNdcs[0];
    if (normalizeNdc(vaccine.ndc ?? null) === reportNdc) continue; // already on file, nothing to adopt

    const owner = { name: vaccine.name, ndc: vaccine.ndc ?? null };

    // Guard 1: a known altNdc for the SAME product is never "the
    // correct NDC" — it's an old/variant identifier tolerated only for
    // on-hand matching (see ProductCatalogMatch.altNdcs).
    if (isKnownAltNdcForProduct(owner, reportNdc)) {
      skipped.push({ vaccineId, vaccineName: vaccine.name, ndc: reportNdc, reason: "alt-ndc" });
      continue;
    }

    // Guard 2a: the candidate NDC is already on file as a DIFFERENT
    // vaccine row's own ndc — never steal another product's NDC.
    const claimedByOtherRow = catalog.some(
      (other) => other.id !== vaccineId && normalizeNdc(other.ndc ?? null) === reportNdc
    );
    if (claimedByOtherRow) {
      skipped.push({ vaccineId, vaccineName: vaccine.name, ndc: reportNdc, reason: "other-product" });
      continue;
    }

    // Guard 2b: static research already knows this NDC belongs to a
    // DIFFERENT product, even if no DB row currently holds it.
    if (ndcBelongsToOtherProduct(owner, reportNdc)) {
      skipped.push({ vaccineId, vaccineName: vaccine.name, ndc: reportNdc, reason: "other-product" });
      continue;
    }

    const formatted = formatNdcForStorage(reportNdc);
    if (!formatted) continue; // report NDC wasn't 10-11 digits once normalized — not a well-formed NDC, don't write it

    candidates.push({ vaccineId, vaccineName: vaccine.name, oldNdc: vaccine.ndc ?? null, newNdc: formatted });
  }

  // Guard 3: cross-batch dedupe — never adopt the same NDC onto more
  // than one vaccine row in this one decision pass.
  const candidatesByNdc = new Map<string, NdcAdoption[]>();
  for (const candidate of candidates) {
    const key = normalizeNdc(candidate.newNdc) ?? candidate.newNdc;
    const list = candidatesByNdc.get(key) ?? [];
    list.push(candidate);
    candidatesByNdc.set(key, list);
  }

  const adoptions: NdcAdoption[] = [];
  for (const [ndcKey, group] of candidatesByNdc) {
    if (group.length > 1) {
      for (const candidate of group) {
        skipped.push({ vaccineId: candidate.vaccineId, vaccineName: candidate.vaccineName, ndc: ndcKey, reason: "duplicate-in-batch" });
      }
      continue;
    }
    adoptions.push(group[0]);
  }

  return { adoptions, skipped };
}
