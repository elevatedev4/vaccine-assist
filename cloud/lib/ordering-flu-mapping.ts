import { ORDERING_GROUP_FLU, getOrderingGroup } from "@/lib/ordering-group";
import type { FluCompositeAgeBand } from "@/lib/appointment-table";

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
 * V-Q11 (Will 2026-10-20: "Switch 50-64 to mFlusiva."): the Flu age
 * composite is now split into "3-49" / "50-64" / "65+" (see
 * lib/flu-preference.ts, shared with the macro-codes "F" hotkey so the
 * ordering rule and the preferred-flu rule cannot disagree). "3-49" takes
 * the old "3-64" Flucelvax rule below, "50-64" resolves to mFLUSIVA, and
 * the legacy "3-64" name (counts cached before this change, up to one
 * poll TTL) keeps resolving to Flucelvax exactly as it always did.
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
const MFLUSIVA_NAME_PREFIX = "mflusiva";

/** Shown on the Ordering page when 50-64 appointments were counted as Flucelvax because no active mFLUSIVA product is on file. */
export const MFLUSIVA_FALLBACK_NOTE = "mFLUSIVA not in catalog \u2014 50\u201364 counted as Flucelvax";

/** True when an active catalog product is mFLUSIVA (what the 50-64 band orders). */
export function hasActiveMflusiva(catalog: readonly FluMappingCatalogVaccine[]): boolean {
  return catalog.some((v) => v.active && normalizedName(v).startsWith(MFLUSIVA_NAME_PREFIX));
}

function normalizedName(vaccine: FluMappingCatalogVaccine): string {
  return vaccine.name.trim().toLowerCase();
}

function isFluProduct(vaccine: FluMappingCatalogVaccine): boolean {
  return getOrderingGroup(vaccine.name) === ORDERING_GROUP_FLU;
}

/**
 * ageBand "65+" -> the active catalog vaccine named exactly "Fluad", or
 * null if none is on file/active.
 * ageBand "50-64" -> mFLUSIVA, or (no active mFLUSIVA on file) the same
 * product as "3-49" so the demand is not dropped.
 * ageBand "3-64" -> the active catalog vaccine named exactly "Flucelvax
 * PFS"; if none is active, falls back to any OTHER active Flu-group
 * product that isn't Fluad (Fluad is 65+-only and must never absorb <65
 * demand); returns null if nothing qualifies (the route then simply
 * doesn't add this count to any row's upcoming7d, same tolerant posture
 * as every other unmatched-appointment path there).
 */
export function matchFluAgeBandToVaccine(
  ageBand: FluCompositeAgeBand,
  catalog: readonly FluMappingCatalogVaccine[]
): FluMappingCatalogVaccine | null {
  if (ageBand === "65+") {
    return catalog.find((v) => v.active && normalizedName(v) === FLUAD_NAME) ?? null;
  }

  if (ageBand === "50-64") {
    // The on-file name carries the season ("mFLUSIVA 2026-27"), so match
    // by prefix. When mFLUSIVA is not an active catalog product, 50-64
    // demand must not vanish: it falls back to the Flucelvax rule below
    // (the pre-V-Q11 behavior), and the ordering route surfaces
    // MFLUSIVA_FALLBACK_NOTE so the substitution is visible.
    const mflusiva = catalog.find((v) => v.active && normalizedName(v).startsWith(MFLUSIVA_NAME_PREFIX));
    if (mflusiva) return mflusiva;
    return matchFluAgeBandToVaccine("3-49", catalog);
  }

  if (ageBand === "3-49" || ageBand === "3-64") {
    const activeFlucelvax = catalog.find((v) => v.active && normalizedName(v) === FLUCELVAX_PFS_NAME);
    if (activeFlucelvax) return activeFlucelvax;

    // Never Fluad (65+) and never mFLUSIVA (50-64): neither may absorb
    // this younger band's demand.
    const fallback = catalog.find(
      (v) =>
        v.active &&
        isFluProduct(v) &&
        normalizedName(v) !== FLUAD_NAME &&
        !normalizedName(v).startsWith(MFLUSIVA_NAME_PREFIX)
    );
    return fallback ?? null;
  }

  // "unknown" age band: no product-level attribution rule was specified
  // for it (Will's brief only covers 3-64/65+) — leave it unmatched,
  // same as before this fix.
  return null;
}
