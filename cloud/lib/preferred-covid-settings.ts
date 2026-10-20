import "server-only";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_PREFERRED_COVID,
  PREFERRED_COVID_SETTING_KEY,
  normalizePreferredCovid,
  type PreferredCovidSetting,
} from "@/lib/preferred-covid";

/**
 * Reads the preferred-COVID setting from the generic `app_setting` table
 * (supabase/migrations/0012_app_setting.sql - same table and degrade
 * posture as lib/ordering-settings.ts). Falls back to
 * DEFAULT_PREFERRED_COVID (pending:true) when the table does not exist
 * yet, and to the defaults field by field when no row is saved or a
 * stored value is malformed. Throws on any other Supabase error.
 */
export async function getPreferredCovid(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<{ setting: PreferredCovidSetting; pending: boolean }> {
  const { data, error } = await supabase
    .from("app_setting")
    .select("value")
    .eq("key", PREFERRED_COVID_SETTING_KEY)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return { setting: { ...DEFAULT_PREFERRED_COVID }, pending: true };
    throw error;
  }

  return { setting: normalizePreferredCovid(data?.value), pending: false };
}
