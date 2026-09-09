import { ORDERING_GROUP_FLU, getOrderingGroup } from "@/lib/ordering-group";
import type { FluAgeBucket } from "@/lib/appointment-table";

/**
 * Resolves a Flu appointment's age band to the catalog product its
 * upcoming7d count should land on (V-T-flu-map, Will 2026-09-09
 * verbatim): "Find how COVID appointment counts are attributed to
 * Comirnaty / mNEXSPIKE ... add: flu age <65 (the 3-64 band) → the
 * active Flucelvax product (Flucelvax PFS; if inactive, fall back to
 * any active flu product that is not Fluad, else 0), flu 65+ → Fluad."
 *
 * BEFORE this fix, every Flu appointment (regardless of age) was
 * invisible to app/api/ordering/recommendation/route.ts's upcoming7d
 * count: the route ran the aggregated "Flu · {Age}" composite name
 * through lib/appointment-table.ts's compositeNameToMatchableBase, which
 * collapses BOTH age bands down to the single string "Flu" — losing the
 * exact distinction this mapping needs. See
 * lib/appointment-table.ts's parseFluCompositeAgeBucket, which the route
 * uses INSTEAD of compositeNameToMatchableBase for a Flu composite, to
 * get the real age band before calling matchFluAgeBandToVaccine below.
 *
 * "3-64" resolves by exact (trimmed, case-insensitive) name "Flucelvax
 * PFS" — the pharmacy's seeded catalog name for that product (see
 * supabase/seed/vaccines.sql) — rather than a name-prefix/substring
 * match, so an unrelated product that merely contains "Flucelvax" (e.g.
 * "Flucelvax MDV") is never silently picked up as the fallback target
 * for Flucelvax PFS itself; MDV only ever gets used via the general
 * "any active flu product that is not Fluad" fallback below. "65+"
 * resolves the same way against the exact name "Fluad".
 */
export type FluMappingCatalogVaccine = {
  id: string;
  name: string;
  active: boolean;
};

const FLUCELVAX_PFS_NAME = "flucelvax pfs";
const FLUAD_NAME = "fluad";

function normalizedName(vaccine: FluMappingCatalogVaccine): string {
  return vaccine.name.trim().toLowerCase();
}

function isFluProduct(vaccine: FluMappingCatalogVaccine): boolean {
  return getOrderingGroup(vaccine.name) === ORDERING_GROUP_FLU;
}

/**
 * ageBand "65+" -> the active catalog vaccine named exactly "Fluad", or
 * null if none is on file/active.
 * ageBand "3-64" -> the active catalog vaccine named exactly "Flucelvax
 * PFS"; if none is active, falls back to any OTHER active Flu-group
 * product that isn't Fluad (Fluad is 65+-only and must never absorb <65
 * demand); returns null if nothing qualifies (the route then simply
 * doesn't add this count to any row's upcoming7d, same tolerant posture
 * as every other unmatched-appointment path there).
 */
export function matchFluAgeBandToVaccine(
  ageBand: FluAgeBucket,
  catalog: readonly FluMappingCatalogVaccine[]
): FluMappingCatalogVaccine | null {
  if (ageBand === "65+") {
    return catalog.find((v) => v.active && normalizedName(v) === FLUAD_NAME) ?? null;
  }

  if (ageBand === "3-64") {
    const activeFlucelvax = catalog.find((v) => v.active && normalizedName(v) === FLUCELVAX_PFS_NAME);
    if (activeFlucelvax) return activeFlucelvax;

    const fallback = catalog.find((v) => v.active && isFluProduct(v) && normalizedName(v) !== FLUAD_NAME);
    return fallback ?? null;
  }

  // "unknown" age band: no product-level attribution rule was specified
  // for it (Will's brief only covers 3-64/65+) — leave it unmatched,
  // same as before this fix.
  return null;
}
