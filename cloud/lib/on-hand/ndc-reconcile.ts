import { normalizeNdc, formatNdcForStorage } from "@/lib/ndc";
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
 * ONLY for a line that matched a vaccine some way OTHER than an exact
 * `vaccine.ndc` match (matchPioneerBohRows's pass 1 — see
 * MatchedOnHandRow.matchedByExactNdc) — a pass-1 line's report NDC
 * already equals the on-file ndc by construction, so it's never a
 * reconciliation candidate. Pass 2 (catalog packageNdc), pass 3 (Pioneer
 * name alias), and pass 4 (free-text name match) can all resolve a line
 * whose report NDC DISAGREES with (or is simply missing from)
 * vaccine.ndc — Fluad being the concrete case that motivated this: its
 * DB ndc is last season's, so it never matches by exact ndc, but its
 * name still resolves it, and the report line carries the CURRENT NDC.
 *
 * Grouped per vaccineId (not per row): if every reconciliation-candidate
 * line for a product in this batch agrees on ONE report NDC, that NDC is
 * adopted (returned in `adoptions`, formatted for storage the same way
 * PATCH /api/vaccines/[id] does). If they disagree (more than one
 * distinct report NDC for the same product in the same batch), nothing
 * is adopted for that product — the disagreement is returned in
 * `conflicts` instead, for the caller to log, so the decision to leave
 * vaccine.ndc alone is visible rather than silent.
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

export type NdcConflict = {
  vaccineId: string;
  vaccineName: string;
  /** The distinct (normalized, digits-only) report NDCs that disagreed
   * for this product in this batch. */
  ndcs: string[];
};

export type NdcReconciliationResult = {
  adoptions: NdcAdoption[];
  conflicts: NdcConflict[];
};

export function decideNdcAdoptions(rows: MatchedOnHandRow[], catalog: CatalogVaccine[]): NdcReconciliationResult {
  const reportNdcsByVaccine = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.vaccineId) continue;
    if (row.matchedByExactNdc) continue; // pass 1 — already correct on file
    const normalized = normalizeNdc(row.ndc);
    if (!normalized) continue;

    const set = reportNdcsByVaccine.get(row.vaccineId) ?? new Set<string>();
    set.add(normalized);
    reportNdcsByVaccine.set(row.vaccineId, set);
  }

  const adoptions: NdcAdoption[] = [];
  const conflicts: NdcConflict[] = [];

  for (const [vaccineId, ndcSet] of reportNdcsByVaccine) {
    const vaccine = catalog.find((candidate) => candidate.id === vaccineId);
    if (!vaccine) continue; // shouldn't happen (vaccineId came from this same catalog), but nothing to reconcile against

    const ndcs = [...ndcSet];
    if (ndcs.length > 1) {
      conflicts.push({ vaccineId, vaccineName: vaccine.name, ndcs });
      continue;
    }

    const reportNdc = ndcs[0];
    if (normalizeNdc(vaccine.ndc ?? null) === reportNdc) continue; // already on file, nothing to adopt

    const formatted = formatNdcForStorage(reportNdc);
    if (!formatted) continue; // report NDC wasn't 10-11 digits once normalized — not a well-formed NDC, don't write it

    adoptions.push({ vaccineId, vaccineName: vaccine.name, oldNdc: vaccine.ndc ?? null, newNdc: formatted });
  }

  return { adoptions, conflicts };
}
