import "server-only";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Shared read/validate helpers for GET/PUT /api/macro-codes/settings —
 * per-product override of how many doses a series has, for the
 * /macro-codes tab's "Doses" input (Will's brief). Backed by the same
 * generic `app_setting` table lib/lots-settings.ts and
 * lib/ordering-settings.ts already use; degrades the same
 * never-error way (see this file's getMacroDoseCounts) so a
 * pre-migration environment doesn't 500.
 */

export const MACRO_DOSE_COUNTS_SETTING_KEY = "macro_dose_counts";

/** A valid stored value: a plain object mapping productKey -> an
 * integer dose count between 1 and 4 (the UI's input range). */
export function isValidDoseCountsMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, count]) => typeof key === "string" && key.length > 0 && Number.isInteger(count) && (count as number) >= 1 && (count as number) <= 4
  );
}

export type MacroDoseCountsResult = { doseCounts: Record<string, number>; pending: boolean };

/**
 * Reads the current saved productKey -> doseCount overrides. Returns
 * `{}` (every product falls back to lib/macro-codes.ts's
 * DEFAULT_DOSE_COUNTS) when `app_setting` doesn't exist yet, no row has
 * been saved, or a stored value somehow isn't a valid map. Throws on any
 * OTHER Supabase error so callers can decide how to surface a genuine
 * failure (same posture as lib/lots-settings.ts's getBudEnabledProductKeys).
 */
export async function getMacroDoseCounts(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<MacroDoseCountsResult> {
  const { data, error } = await supabase
    .from("app_setting")
    .select("value")
    .eq("key", MACRO_DOSE_COUNTS_SETTING_KEY)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return { doseCounts: {}, pending: true };
    }
    throw error;
  }

  const value = data?.value;
  if (isValidDoseCountsMap(value)) {
    return { doseCounts: value, pending: false };
  }
  return { doseCounts: {}, pending: false };
}
