import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { isMissingColumnError, isMissingTableError } from "@/lib/schema-degradation";

/**
 * GET /api/on-hand/latest — the most recent Pioneer BOH batch's stored
 * lines, as-ingested (V-onhand-ndc-units, Will 2026-09-09/10: verify
 * NDC reconciliation — lib/on-hand/ndc-reconcile.ts — after the next
 * Pioneer send). Same auth guard as every other /api/on-hand* route
 * (requireAuthenticatedUser). No PHI: on_hand_count is product
 * inventory counts only, never patient data.
 *
 * "Latest batch" uses the SAME time-window + source-match definition as
 * app/api/ordering/recommendation/route.ts's computeLatestBatchOnHand
 * (BATCH_WINDOW_MS, 120s) — applied globally here rather than per
 * product/NDC: take the newest `received_at` row (scoped to this
 * account's inbound address, plus legacy unattributed rows — same
 * scoping fetchOnHandRows there uses), then return every row within 120s
 * of it that shares its `source` (email vs upload). This is exactly
 * "everything this account's most recent report/upload inserted",
 * matched and unmatched rows both — unmatched rows are included on
 * purpose (the point of this endpoint is verifying reconciliation, which
 * needs to see why a line DIDN'T resolve too, not just the ones that
 * did).
 *
 * Degrades gracefully across the same migration gaps
 * app/api/ordering/recommendation/route.ts's fetchOnHandRows already
 * handles: `ndc`/`stock_size` (0011) and `source`/scoping (0010) may not
 * exist yet in this environment — see the cascading query below.
 *
 * RESPONSE CONTRACT: { lines: [{ vaccineNameRaw, ndc, stockSize,
 * quantity, vaccineId, matched, receivedAt }] } — lines is [] when there
 * are no on_hand_count rows at all for this account.
 */

const BATCH_WINDOW_MS = 120_000; // 120 seconds — same window as the recommendation route

type RawRow = {
  vaccine_name_raw: string;
  ndc: string | null;
  stock_size: number | null;
  quantity: number | null;
  vaccine_id: string | null;
  matched: boolean;
  received_at: string;
  source?: string;
};

async function fetchRecentRows(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  addressId: string | null
): Promise<{ data: RawRow[] | null; error: unknown }> {
  const baseColumns = "vaccine_name_raw, quantity, vaccine_id, matched, received_at";
  const columnsWithNdcAndSource = `${baseColumns}, ndc, stock_size, source`;

  async function runQuery(columns: string, scoped: boolean) {
    let query = supabase.from("on_hand_count").select(columns);
    if (scoped && addressId) {
      query = query.or(`inbound_email_address_id.eq.${addressId},inbound_email_address_id.is.null`);
    }
    return query.order("received_at", { ascending: false });
  }

  let { data, error } = await runQuery(columnsWithNdcAndSource, true);
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery(baseColumns, true));
  }
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await runQuery(baseColumns, false));
  }
  return { data: (data as RawRow[] | null) ?? null, error };
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let addressId: string | null = null;
  try {
    addressId = (await getOrCreateAddressForUser(auth.user.id)).id;
  } catch (err) {
    if (!isMissingTableError(err)) {
      console.error("GET /api/on-hand/latest: on-hand address lookup failed", err);
      return NextResponse.json({ error: "on-hand lookup failed" }, { status: 503 });
    }
    addressId = null;
  }

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await fetchRecentRows(supabase, addressId);

    if (error) {
      console.error("GET /api/on-hand/latest: failed to load on-hand counts", error);
      return NextResponse.json({ error: "Failed to load on-hand counts." }, { status: 500 });
    }

    const rows = data ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ lines: [] });
    }

    // Rows are ordered received_at DESC by the query, but the newest is
    // found by explicit comparison rather than trusting rows[0] — same
    // defensive posture as the recommendation route's
    // computeLatestBatchOnHand.
    let newest = rows[0];
    for (const row of rows) {
      if (row.received_at > newest.received_at) newest = row;
    }
    const newestSource = newest.source ?? "email";
    const windowStartMs = new Date(newest.received_at).getTime() - BATCH_WINDOW_MS;

    const lines = rows
      .filter((row) => (row.source ?? "email") === newestSource)
      .filter((row) => new Date(row.received_at).getTime() >= windowStartMs)
      .map((row) => ({
        vaccineNameRaw: row.vaccine_name_raw,
        ndc: row.ndc ?? null,
        stockSize: row.stock_size ?? null,
        quantity: row.quantity,
        vaccineId: row.vaccine_id,
        matched: row.matched,
        receivedAt: row.received_at,
      }));

    return NextResponse.json({ lines });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
