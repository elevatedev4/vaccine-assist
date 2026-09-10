import "server-only";
import { isMissingColumnError } from "@/lib/schema-degradation";
import type { MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import { decideNdcAdoptions } from "@/lib/on-hand/ndc-reconcile";
import type { getSupabaseServerClient } from "@/lib/supabase/server";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

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
 *
 * NDC reconciliation (V-onhand-ndc-units, Will 2026-09-09/10 — "The BOH
 * report I'm sending has the NDC in the report... this is important to
 * understanding the true BOH"): when a `catalog` is given AND the insert
 * above succeeded, `rows` is run through lib/on-hand/ndc-reconcile.ts's
 * decideNdcAdoptions and every resulting adoption is written to
 * vaccine.ndc on this SAME Supabase client — this is the one place both
 * the manual-upload route and the SES webhook funnel their parsed rows
 * through, so every Pioneer send (email or manual upload) self-corrects
 * a stale/wrong on-file NDC. `catalog` is optional so a caller that
 * hasn't been updated (or a legacy plain-text batch with no report NDCs
 * at all) simply skips reconciliation — decideNdcAdoptions would find
 * nothing to adopt anyway, but skipping the extra Supabase round-trip
 * when there's no catalog to reconcile against is cheap and explicit.
 * Reconciliation failures are logged and swallowed — never surfaced as
 * this function's `error` — since the on_hand_count rows themselves
 * already inserted successfully; a failed NDC update shouldn't make an
 * otherwise-successful ingest look like it failed.
 */
export async function insertOnHandRows(
  supabase: SupabaseClient,
  rows: MatchedOnHandRow[],
  options: InsertOnHandOptions = {},
  catalog?: CatalogVaccine[]
): Promise<{ error: unknown }> {
  if (rows.length === 0) return { error: null };

  let dbRows = rows.map((row) => buildRow(row, options, true));
  let { error } = await supabase.from("on_hand_count").insert(dbRows);

  if (error && isMissingColumnError(error)) {
    dbRows = rows.map((row) => buildRow(row, options, false));
    ({ error } = await supabase.from("on_hand_count").insert(dbRows));
  }

  if (!error && catalog) {
    await reconcileNdcFromReport(supabase, rows, catalog);
  }

  return { error };
}

async function reconcileNdcFromReport(
  supabase: SupabaseClient,
  rows: MatchedOnHandRow[],
  catalog: CatalogVaccine[]
): Promise<void> {
  let result: ReturnType<typeof decideNdcAdoptions>;
  try {
    result = decideNdcAdoptions(rows, catalog);
  } catch (err) {
    console.warn("insertOnHandRows: NDC reconciliation decision failed — skipping", err);
    return;
  }

  for (const skip of result.skipped) {
    if (skip.reason === "alt-ndc") {
      console.warn(
        `NDC reconciliation: alt NDC, not adopted — ${skip.vaccineName} report NDC ${skip.ndc} is a known alternate NDC for this product, leaving vaccine.ndc unchanged`
      );
    } else if (skip.reason === "other-product") {
      console.warn(
        `NDC reconciliation: NDC ${skip.ndc} belongs to a different product — not adopted onto ${skip.vaccineName}`
      );
    } else if (skip.reason === "duplicate-in-batch") {
      console.warn(
        `NDC reconciliation: NDC ${skip.ndc} would be adopted by more than one product in this batch — not adopted onto ${skip.vaccineName}`
      );
    } else if (skip.reason === "no-stock") {
      console.warn(`NDC reconciliation: ${skip.vaccineName} — no stock on any line, leaving vaccine.ndc unchanged`);
    } else {
      console.warn(
        `NDC reconciliation: ${skip.vaccineName} — batch lines tied for highest stock across distinct report NDCs [${skip.ndc}], leaving vaccine.ndc unchanged`
      );
    }
  }

  for (const adoption of result.adoptions) {
    const { error } = await supabase.from("vaccine").update({ ndc: adoption.newNdc }).eq("id", adoption.vaccineId);
    if (error) {
      console.error(`insertOnHandRows: failed to update ${adoption.vaccineName} ndc - ${(error as { message?: string })?.message}`, error);
      continue;
    }
    console.log(`NDC adopted from Pioneer report: ${adoption.vaccineName} ${adoption.oldNdc ?? "(none)"} → ${adoption.newNdc}`);
  }
}
