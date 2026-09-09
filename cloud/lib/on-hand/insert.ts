import "server-only";
import { isMissingColumnError } from "@/lib/schema-degradation";
import type { MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseClient = ReturnType<typeof getSupabaseServerClient>;

export type InsertOnHandOptions = {
  /** This account's inbound_email_address id — omitted (not even null)
   * from every inserted row's inbound_email_address_id/source when this
   * is null/undefined, same "legacy, unattributed" posture as before
   * V-onhand-account-address. */
  addressId?: string | null;
  /** on_hand_count.source ("upload" or "email") — only written when
   * addressId is also present, since a source with no address to pair
   * it with isn't meaningful and 0010 added both columns together. */
  source?: string;
};

function buildRow(row: MatchedOnHandRow, options: InsertOnHandOptions, includeNdc: boolean): Record<string, unknown> {
  const dbRow: Record<string, unknown> = {
    raw_line: row.rawLine,
    vaccine_name_raw: row.vaccineNameRaw,
    quantity: row.quantity,
    vaccine_id: row.vaccineId,
    matched: row.matched,
  };
  if (options.addressId) {
    dbRow.inbound_email_address_id = options.addressId;
    if (options.source) dbRow.source = options.source;
  }
  if (includeNdc) {
    dbRow.ndc = row.ndc;
    dbRow.stock_size = row.stockSize;
  }
  return dbRow;
}

/**
 * Batch-inserts parsed on-hand rows into on_hand_count, degrading
 * gracefully when supabase/migrations/0011_on_hand_ndc_and_targets.sql
 * hasn't been applied yet: tries the insert WITH ndc/stock_size first,
 * and on a missing-column error (lib/schema-degradation.ts) retries
 * WITHOUT those two columns — same "try, catch, retry" shape 0009/0010
 * already established, so uploads work today and pick up the new
 * columns automatically once the migration runs, no code change needed.
 */
export async function insertOnHandRows(
  supabase: SupabaseClient,
  rows: MatchedOnHandRow[],
  options: InsertOnHandOptions = {}
): Promise<{ error: unknown }> {
  if (rows.length === 0) return { error: null };

  let dbRows = rows.map((row) => buildRow(row, options, true));
  let { error } = await supabase.from("on_hand_count").insert(dbRows);

  if (error && isMissingColumnError(error)) {
    dbRows = rows.map((row) => buildRow(row, options, false));
    ({ error } = await supabase.from("on_hand_count").insert(dbRows));
  }

  return { error };
}
