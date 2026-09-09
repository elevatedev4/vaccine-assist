import "server-only";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildProductViews, type ProductViewVaccine } from "@/lib/product-view";

/**
 * Shared read/validate helpers for GET/PUT /api/lots/settings — which
 * product(s) show an editable beyond-use-date cell on /lots (V-T-ordering-
 * lots-round3, Will 2026-09-09 verbatim: "Beyond-use date only needs to
 * apply to mNexspike right now. Add a settings menu icon ... where you
 * can enable Beyond Use Date too."). Backed by the SAME generic
 * `app_setting` table (supabase/migrations/0012_app_setting.sql —
 * confirmed already applied in prod per this change's brief) as
 * lib/ordering-settings.ts uses for the walk-up % setting; this file
 * degrades the same never-error way anyway, for consistency with the
 * rest of this codebase and so a future pre-migration environment
 * doesn't 500.
 */

export const BUD_ENABLED_PRODUCTS_SETTING_KEY = "lots.bud_enabled_products";

/**
 * The DEFAULT lots.bud_enabled_products value when nothing has ever been
 * saved: mNEXSPIKE's productKey (Will's brief: "seed the default so
 * mNEXSPIKE's productKey is enabled when the setting is absent"). NOT a
 * hardcoded string — computed from the LIVE vaccine catalog via
 * lib/product-view.ts's buildProductViews, so it keeps matching
 * mNEXSPIKE's real lib/lots-grouping.ts key (today a `name:` key, since
 * mNEXSPIKE has no NDC on file — see supabase/seed/vaccines.sql — but an
 * `ndc:` key the moment it gets one) rather than a value that could
 * silently stop matching if that ever changes. Returns [] if no product
 * view's display name mentions mNEXSPIKE at all (an empty/unusual
 * catalog — defensive, not expected in practice).
 */
export function defaultBudEnabledProductKeys(vaccines: readonly ProductViewVaccine[]): string[] {
  const match = buildProductViews(vaccines).find((view) => view.displayName.toLowerCase().includes("mnexspike"));
  return match ? [match.productKey] : [];
}

export function isValidProductKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

export type BudSettingResult = { productKeys: string[]; pending: boolean };

/**
 * Reads the current effective set of BUD-enabled productKeys —
 * defaultBudEnabledProductKeys(vaccines) (with pending:true) when
 * `app_setting` doesn't exist yet OR no row has been saved yet OR a
 * stored value somehow isn't a valid string array (defensive — PUT
 * already validates, but a row could in principle be edited directly).
 * Throws on any OTHER Supabase error so callers can decide how to
 * surface a genuine failure (same posture as lib/ordering-settings.ts's
 * getWalkInPct).
 */
export async function getBudEnabledProductKeys(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  vaccines: readonly ProductViewVaccine[]
): Promise<BudSettingResult> {
  const fallback = defaultBudEnabledProductKeys(vaccines);

  const { data, error } = await supabase
    .from("app_setting")
    .select("value")
    .eq("key", BUD_ENABLED_PRODUCTS_SETTING_KEY)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return { productKeys: fallback, pending: true };
    }
    throw error;
  }

  const value = data?.value;
  if (isValidProductKeyList(value)) {
    return { productKeys: value, pending: false };
  }
  return { productKeys: fallback, pending: false };
}
