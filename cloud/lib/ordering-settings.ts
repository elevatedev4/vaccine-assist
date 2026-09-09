import "server-only";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Shared read/validate helpers for the "walk-up %" Ordering-screen
 * setting (V-T26 item 1, Will 2026-09-09) — backed by the generic
 * `app_setting` table (supabase/migrations/0012_app_setting.sql,
 * MIGRATION FILE ONLY per Will's brief). Used by both
 * app/api/ordering/settings/route.ts (GET/PUT the raw setting) and
 * app/api/ordering/recommendation/route.ts (reads the effective pct to
 * pass into lib/ordering-recommendation.ts / lib/ordering-targets.ts's
 * `rate` parameter).
 *
 * Same degrade-before-migration posture as
 * lib/schema-degradation.ts's doc comment describes: every reader below
 * falls back to DEFAULT_WALK_IN_PCT (never throws, never 500s) when
 * `app_setting` doesn't exist yet.
 */

export const WALK_IN_PCT_SETTING_KEY = "ordering.walk_in_pct";

/** The rate hard-coded before this setting existed
 * (lib/ordering-recommendation.ts's WALK_IN_BUFFER_RATE, 0.25 = 25%) —
 * also this setting's default value before staff ever change it, or
 * before 0012 has been applied. */
export const DEFAULT_WALK_IN_PCT = 25;

/** A valid walk-up % is an integer 0-100 (Will's brief). */
export function isValidWalkInPct(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** pct (0-100) -> the 0-1 rate lib/ordering-recommendation.ts's
 * walkInBuffer/computeRecommendedOrder and lib/ordering-targets.ts's
 * recommendedTarget/computeEffectiveTargets expect. */
export function walkInPctToRate(pct: number): number {
  return pct / 100;
}

export type WalkInPctResult = { pct: number; pending: boolean };

/**
 * Reads the current effective walk-up % — DEFAULT_WALK_IN_PCT (with
 * pending:true) when `app_setting` doesn't exist yet (0012 pending) OR
 * no row has been saved yet OR a stored value somehow isn't a valid
 * pct (defensive — PUT already validates, but a row could in principle
 * be edited directly). Throws on any OTHER Supabase error so callers can
 * decide how to surface a genuine failure (same posture as every other
 * *Error-vs-missing-table split in this app — see
 * lib/schema-degradation.ts).
 */
export async function getWalkInPct(supabase: ReturnType<typeof getSupabaseServerClient>): Promise<WalkInPctResult> {
  const { data, error } = await supabase
    .from("app_setting")
    .select("value")
    .eq("key", WALK_IN_PCT_SETTING_KEY)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return { pct: DEFAULT_WALK_IN_PCT, pending: true };
    }
    throw error;
  }

  const value = data?.value;
  if (isValidWalkInPct(value)) {
    return { pct: value, pending: false };
  }
  return { pct: DEFAULT_WALK_IN_PCT, pending: false };
}
