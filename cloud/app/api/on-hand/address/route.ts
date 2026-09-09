import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildAddress, getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { isMissingColumnError, isMissingTableError } from "@/lib/schema-degradation";

/**
 * GET /api/on-hand/address — the current user's on-hand-report inbound
 * email address (V-onhand-account-address, Will 2026-09-08). Creates the
 * address on first call. Consumed by app/settings/page.tsx (always shown)
 * and app/ordering/page.tsx (shown as a setup card until `hasData`).
 *
 * RESPONSE CONTRACT:
 *   { address, token, lastReceivedAt, hasData }
 *   or, before supabase/migrations/0010_inbound_email_address.sql has
 *   been applied to this environment: { pending: true } (200, not an
 *   error — the brief's "MIGRATION FILE ONLY, don't run it" posture means
 *   this route must keep working, just inert, until Will applies it).
 *
 * `hasData` is true when this account has ANY on_hand_count row
 * (matched or not — even an unmatched line proves data arrived), OR
 * (transitionally) when any row exists with a null
 * inbound_email_address_id at all — rows inserted before this feature
 * shipped, back when there was only one shared pharmacy login and no
 * concept of "whose" on-hand data a row was. Without this fallback, an
 * existing single-pharmacy install with months of email history would
 * suddenly look brand new the moment this ships.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let address;
  try {
    address = await getOrCreateAddressForUser(auth.user.id);
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ pending: true });
    }
    console.error("GET /api/on-hand/address: failed to resolve address", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  try {
    const supabase = getSupabaseServerClient();

    let { count, error } = await supabase
      .from("on_hand_count")
      .select("id", { count: "exact", head: true })
      .or(`inbound_email_address_id.eq.${address.id},inbound_email_address_id.is.null`);

    if (error && isMissingColumnError(error)) {
      // 0010 created inbound_email_address but this environment's
      // on_hand_count hasn't picked up inbound_email_address_id yet —
      // fall back to "any row at all" rather than failing the request.
      ({ count, error } = await supabase.from("on_hand_count").select("id", { count: "exact", head: true }));
    }

    if (error) {
      console.error("GET /api/on-hand/address: failed to check for existing on-hand data", error);
      return NextResponse.json({ error: "Failed to load on-hand status." }, { status: 500 });
    }

    return NextResponse.json({
      address: buildAddress(address.token),
      token: address.token,
      lastReceivedAt: address.lastReceivedAt,
      hasData: (count ?? 0) > 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
