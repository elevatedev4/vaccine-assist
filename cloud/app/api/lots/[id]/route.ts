import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * PATCH /api/lots/[id] — edits an existing lot's editable fields. New for
 * V-cloud-tabs (Will 2026-09-05/07): the rebuilt /lots page edits a
 * vaccine's CURRENT active lot in place (lot number / expiration /
 * beyond-use date) rather than only ever adding new lots, so it needs a
 * per-lot update route the desktop app's Lots screen never required.
 * Body: { lot_number?, expiration?, beyond_use_date?, note?, status? } —
 * at least one field required.
 *
 * beyond_use_date degrades the same way as app/api/lots/route.ts: if the
 * column doesn't exist yet (supabase/migrations/0009_...), the update
 * retries without it and flags `beyondUseDateSupported: false`.
 *
 * DELETE /api/lots/[id] — V-T21 item 5 (Will, 2026-09-08): the data-entry
 * popup's "Update current lots to this lot" checkbox saves a fresh lot
 * then deletes every OTHER lot on file for that vaccine (see desktop
 * DataEntryPopupViewModel.ApplyUpdateCurrentLotAsync) — needs a per-lot
 * delete route neither screen required before.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing lot id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { lot_number, expiration, beyond_use_date, note, status } = body ?? {};

    const update: Record<string, unknown> = {};
    if (lot_number !== undefined) {
      if (typeof lot_number !== "string" || !lot_number.trim()) {
        return NextResponse.json({ error: "lot_number must be a non-empty string." }, { status: 400 });
      }
      update.lot_number = lot_number;
    }
    if (expiration !== undefined) {
      if (typeof expiration !== "string" || !expiration) {
        return NextResponse.json({ error: "expiration must be a date string." }, { status: 400 });
      }
      update.expiration = expiration;
    }
    if (beyond_use_date !== undefined) {
      if (beyond_use_date !== null && typeof beyond_use_date !== "string") {
        return NextResponse.json({ error: "beyond_use_date must be a date string or null." }, { status: 400 });
      }
      update.beyond_use_date = beyond_use_date;
    }
    if (note !== undefined) {
      if (note !== null && typeof note !== "string") {
        return NextResponse.json({ error: "note must be a string or null." }, { status: 400 });
      }
      update.note = note;
    }
    if (status !== undefined) {
      if (status !== "active" && status !== "depleted") {
        return NextResponse.json({ error: "status must be 'active' or 'depleted'." }, { status: 400 });
      }
      update.status = status;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    let { data, error } = await supabase.from("lot").update(update).eq("id", id).select().single();
    let beyondUseDateSupported = true;

    if (error && isMissingColumnError(error) && "beyond_use_date" in update) {
      beyondUseDateSupported = false;
      const { beyond_use_date: _bud, ...withoutBud } = update;
      if (Object.keys(withoutBud).length === 0) {
        return NextResponse.json(
          { error: "beyond_use_date is not available yet — the migration hasn't run.", beyondUseDateSupported },
          { status: 409 }
        );
      }
      ({ data, error } = await supabase.from("lot").update(withoutBud).eq("id", id).select().single());
    }

    if (error) {
      console.error("PATCH /api/lots/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update lot." }, { status: 500 });
    }

    return NextResponse.json({ lot: data, beyondUseDateSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing lot id." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.from("lot").delete().eq("id", id);

    if (error) {
      console.error("DELETE /api/lots/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to delete lot." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
