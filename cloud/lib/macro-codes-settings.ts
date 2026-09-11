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

/**
 * Applies a PARTIAL update (`patch`, e.g. `{ "ndc:shingrix": 3 }` — just
 * the one product a viewer just changed) on top of whatever's currently
 * saved, then writes the merged whole map back. This is a read-merge-
 * write, not an atomic DB-level merge, but it's what fixes the race
 * PUT previously had: two devices each PUTting a stale FULL local copy
 * of the map (one editing product A, the other product B) could
 * silently clobber each other's change. Sending only the changed key
 * and merging server-side means either device's write only ever
 * touches its own key, however stale its view of everyone else's.
 *
 * Reads via getMacroDoseCounts (same fallback/throw posture), merges,
 * then upserts. Returns the MERGED map (not just `patch`) so the caller
 * can set its local state to the authoritative saved value. Throws on a
 * genuine (non-missing-table) error from either the read or the write.
 */
export async function updateMacroDoseCounts(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  patch: Readonly<Record<string, number>>
): Promise<MacroDoseCountsResult> {
  const current = await getMacroDoseCounts(supabase);
  const merged = { ...current.doseCounts, ...patch };

  const { error } = await supabase
    .from("app_setting")
    .upsert(
      { key: MACRO_DOSE_COUNTS_SETTING_KEY, value: merged, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    if (isMissingTableError(error)) {
      return { doseCounts: merged, pending: true };
    }
    throw error;
  }

  return { doseCounts: merged, pending: false };
}
