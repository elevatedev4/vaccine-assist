import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * REST endpoint for the desktop app's Lots screen (inventory +
 * expirations), also used by the rebuilt web /lots page (V-cloud-tabs,
 * Will 2026-09-05/07: one row per active vaccine, inline-editable lot
 * number/expiration/beyond-use date). GET lists lots, optionally
 * filtered by ?vaccineId= or ?status=active|depleted. POST creates a lot
 * (used both by the Lots screen's "add a shipment" flow and by the /lots
 * page's per-row save when a vaccine has no current active lot yet).
 *
 * `beyond_use_date` is an additive column
 * (supabase/migrations/0009_lots_bud_vaccine_defaults.sql) that may not
 * exist yet on a given database — see lib/schema-degradation.ts. Both
 * GET and POST here try the full column set first and transparently
 * retry without beyond_use_date if Postgres reports it's missing,
 * flagging `beyondUseDateSupported: false` in the response rather than
 * failing outright.
 *
 * V-T28 (Will 2026-09-09: "the app still shows multiple lines for each
 * vaccine ... there should be one row per item"): the /lots page now
 * groups per-dose vaccine rows into one PRODUCT row (lib/lots-grouping.ts)
 * — a product's own vaccine rows share one NDC (or, for a null-NDC dose
 * like Vaqta's second dose, a matching name). Editing that one row must
 * still keep every underlying dose's lot data in sync, so this file adds
 * three FAN-OUT entry points alongside the single-vaccine ones above,
 * done server-side (per Will's brief) so the client stays simple:
 *  - POST here also accepts `vaccine_ids: string[]` (plural) to insert
 *    the SAME new lot on every dose vaccine_id of a product at once,
 *    instead of the existing singular `vaccine_id` path.
 *  - PATCH (new) UPSERTS, on EVERY vaccine_id in `vaccineIds`: updates
 *    whichever lot currently has `matchLotNumber` — the product row's
 *    lot number as loaded, before this edit (which may itself change
 *    lot_number) — or, if a dose has no lot with that number (already
 *    drifted apart, or never had one), INSERTS a fresh one with the new
 *    values instead, so dose rows can never drift apart after an edit.
 *  - DELETE (new) removes, on EVERY vaccine_id in `vaccineIds`, the lot
 *    whose lot_number is `lot_number`.
 * The existing per-lot GET/POST above and PATCH/DELETE at
 * app/api/lots/[id]/route.ts are untouched and still back the desktop
 * Lots screen and the data-entry popup's single-lot flows.
 */
const LOT_COLUMNS_BASE = "id, vaccine_id, lot_number, expiration, status, note, created_at, updated_at";
const LOT_COLUMNS_FULL = `${LOT_COLUMNS_BASE}, beyond_use_date`;

function buildLotsQuery(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  columns: string,
  vaccineId: string | null,
  status: string | null
) {
  let query = supabase.from("lot").select(columns).order("expiration", { ascending: true });
  if (vaccineId) query = query.eq("vaccine_id", vaccineId);
  if (status) query = query.eq("status", status);
  return query;
}

export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const { searchParams } = new URL(request.url);
    const vaccineId = searchParams.get("vaccineId");
    const status = searchParams.get("status");

    let { data, error } = await buildLotsQuery(supabase, LOT_COLUMNS_FULL, vaccineId, status);
    let beyondUseDateSupported = true;

    if (error && isMissingColumnError(error)) {
      beyondUseDateSupported = false;
      ({ data, error } = await buildLotsQuery(supabase, LOT_COLUMNS_BASE, vaccineId, status));
    }

    if (error) {
      console.error("GET /api/lots: Supabase error", error);
      return NextResponse.json({ error: "Failed to load lots." }, { status: 500 });
    }

    return NextResponse.json({ lots: data, beyondUseDateSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const body = await request.json();

    const { vaccine_id, vaccine_ids, lot_number, expiration, status, note, beyond_use_date } = body ?? {};
    if (beyond_use_date !== undefined && beyond_use_date !== null && typeof beyond_use_date !== "string") {
      return NextResponse.json({ error: "beyond_use_date must be a date string or null." }, { status: 400 });
    }

    // V-T28 fan-out create: a product row's "add a lot" writes the SAME
    // new lot onto every dose vaccine_id of the product at once.
    if (vaccine_ids !== undefined) {
      if (!Array.isArray(vaccine_ids) || vaccine_ids.length === 0 || vaccine_ids.some((id) => typeof id !== "string" || !id)) {
        return NextResponse.json({ error: "vaccine_ids must be a non-empty array of vaccine ids." }, { status: 400 });
      }
      if (!lot_number || !expiration) {
        return NextResponse.json({ error: "vaccine_ids, lot_number, and expiration are required." }, { status: 400 });
      }

      const basePayload = { lot_number, expiration, status: status ?? "active", note };
      const fullPayloads = vaccine_ids.map((id: string) => ({
        vaccine_id: id,
        ...basePayload,
        ...(beyond_use_date !== undefined ? { beyond_use_date } : {}),
      }));

      let { data, error } = await supabase.from("lot").insert(fullPayloads).select();
      let beyondUseDateSupported = true;

      if (error && isMissingColumnError(error) && beyond_use_date !== undefined) {
        beyondUseDateSupported = false;
        const reducedPayloads = vaccine_ids.map((id: string) => ({ vaccine_id: id, ...basePayload }));
        ({ data, error } = await supabase.from("lot").insert(reducedPayloads).select());
      }

      if (error) {
        console.error("POST /api/lots (fan-out): Supabase error", error);
        return NextResponse.json({ error: "Failed to create lot." }, { status: 500 });
      }

      return NextResponse.json({ lots: data, beyondUseDateSupported }, { status: 201 });
    }

    if (!vaccine_id || !lot_number || !expiration) {
      return NextResponse.json(
        { error: "vaccine_id, lot_number, and expiration are required." },
        { status: 400 }
      );
    }

    const insertPayload: Record<string, unknown> = {
      vaccine_id,
      lot_number,
      expiration,
      status: status ?? "active",
      note,
    };
    if (beyond_use_date !== undefined) insertPayload.beyond_use_date = beyond_use_date;

    let { data, error } = await supabase.from("lot").insert(insertPayload).select().single();
    let beyondUseDateSupported = true;

    if (error && isMissingColumnError(error) && "beyond_use_date" in insertPayload) {
      beyondUseDateSupported = false;
      const { beyond_use_date: _bud, ...withoutBud } = insertPayload;
      ({ data, error } = await supabase.from("lot").insert(withoutBud).select().single());
    }

    if (error) {
      console.error("POST /api/lots: Supabase error", error);
      return NextResponse.json({ error: "Failed to create lot." }, { status: 500 });
    }

    return NextResponse.json({ lot: data, beyondUseDateSupported }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

/**
 * V-T28 fan-out edit — UPSERT (Will, follow-up: "make the collection-
 * level PATCH an upsert ... so the dose rows can never drift apart after
 * an edit"): a product row's Save applies the new lot_number/expiration/
 * beyond_use_date to EVERY vaccine_id in `vaccineIds`. For each
 * vaccine_id, it first tries to UPDATE whichever lot currently matches
 * `matchLotNumber` (the row's lot number as loaded, before this edit —
 * needed since `lot_number` itself may be a rename in flight); if that
 * dose has no lot with that number (already drifted apart, or simply
 * never got one — see this route's earlier "known limitation" note),
 * it INSERTS a fresh lot on that dose with the new values instead of
 * silently leaving it behind. Body: { vaccineIds: string[],
 * matchLotNumber: string, lot_number: string, expiration: string,
 * beyond_use_date?, note?, status? } — lot_number and expiration are
 * REQUIRED here (unlike PATCH /api/lots/[id]'s partial-update shape)
 * because either one might need to become a brand-new row.
 */
export async function PATCH(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    const { vaccineIds, matchLotNumber, lot_number, expiration, beyond_use_date, note, status } = body ?? {};

    if (!Array.isArray(vaccineIds) || vaccineIds.length === 0 || vaccineIds.some((id: unknown) => typeof id !== "string" || !id)) {
      return NextResponse.json({ error: "vaccineIds must be a non-empty array of vaccine ids." }, { status: 400 });
    }
    if (typeof matchLotNumber !== "string" || !matchLotNumber.trim()) {
      return NextResponse.json({ error: "matchLotNumber is required." }, { status: 400 });
    }
    if (typeof lot_number !== "string" || !lot_number.trim()) {
      return NextResponse.json({ error: "lot_number must be a non-empty string." }, { status: 400 });
    }
    if (typeof expiration !== "string" || !expiration) {
      return NextResponse.json({ error: "expiration must be a date string." }, { status: 400 });
    }
    if (beyond_use_date !== undefined && beyond_use_date !== null && typeof beyond_use_date !== "string") {
      return NextResponse.json({ error: "beyond_use_date must be a date string or null." }, { status: 400 });
    }
    if (note !== undefined && note !== null && typeof note !== "string") {
      return NextResponse.json({ error: "note must be a string or null." }, { status: 400 });
    }
    if (status !== undefined && status !== "active" && status !== "depleted") {
      return NextResponse.json({ error: "status must be 'active' or 'depleted'." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    let beyondUseDateSupported = true;

    const buildUpdatePayload = (): Record<string, unknown> => {
      const payload: Record<string, unknown> = { lot_number, expiration };
      if (status !== undefined) payload.status = status;
      if (note !== undefined) payload.note = note;
      if (beyond_use_date !== undefined && beyondUseDateSupported) payload.beyond_use_date = beyond_use_date;
      return payload;
    };
    const buildInsertPayload = (vaccineId: string): Record<string, unknown> => {
      const payload: Record<string, unknown> = { vaccine_id: vaccineId, lot_number, expiration, status: status ?? "active", note };
      if (beyond_use_date !== undefined && beyondUseDateSupported) payload.beyond_use_date = beyond_use_date;
      return payload;
    };

    const results: unknown[] = [];

    for (const vaccineId of vaccineIds as string[]) {
      let updatePayload = buildUpdatePayload();
      let { data, error } = await supabase
        .from("lot")
        .update(updatePayload)
        .eq("vaccine_id", vaccineId)
        .eq("lot_number", matchLotNumber)
        .select();

      if (error && isMissingColumnError(error) && "beyond_use_date" in updatePayload) {
        beyondUseDateSupported = false;
        updatePayload = buildUpdatePayload();
        ({ data, error } = await supabase
          .from("lot")
          .update(updatePayload)
          .eq("vaccine_id", vaccineId)
          .eq("lot_number", matchLotNumber)
          .select());
      }

      if (error) {
        console.error("PATCH /api/lots (fan-out): Supabase error", error);
        return NextResponse.json({ error: "Failed to update lot." }, { status: 500 });
      }

      if (data && data.length > 0) {
        results.push(...data);
        continue;
      }

      // Upsert fallback: this dose's lot rows didn't include
      // matchLotNumber — nothing to update, so insert a fresh lot on it
      // with the new values rather than leaving it out of sync.
      let insertPayload = buildInsertPayload(vaccineId);
      let insertResult = await supabase.from("lot").insert(insertPayload).select().single();

      if (insertResult.error && isMissingColumnError(insertResult.error) && "beyond_use_date" in insertPayload) {
        beyondUseDateSupported = false;
        insertPayload = buildInsertPayload(vaccineId);
        insertResult = await supabase.from("lot").insert(insertPayload).select().single();
      }

      if (insertResult.error) {
        console.error("PATCH /api/lots (fan-out upsert-insert): Supabase error", insertResult.error);
        return NextResponse.json({ error: "Failed to update lot." }, { status: 500 });
      }

      results.push(insertResult.data);
    }

    return NextResponse.json({ lots: results, beyondUseDateSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}

/**
 * V-T28 fan-out delete: removes whichever lot matches `lot_number` on
 * EVERY vaccine_id in `vaccineIds` — a product row's "Delete lot" clears
 * that lot from every dose at once. Body: { vaccineIds: string[],
 * lot_number: string }.
 */
export async function DELETE(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const body = await request.json();
    const { vaccineIds, lot_number } = body ?? {};

    if (!Array.isArray(vaccineIds) || vaccineIds.length === 0 || vaccineIds.some((id: unknown) => typeof id !== "string" || !id)) {
      return NextResponse.json({ error: "vaccineIds must be a non-empty array of vaccine ids." }, { status: 400 });
    }
    if (typeof lot_number !== "string" || !lot_number.trim()) {
      return NextResponse.json({ error: "lot_number is required." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    for (const vaccineId of vaccineIds as string[]) {
      const { error } = await supabase.from("lot").delete().eq("vaccine_id", vaccineId).eq("lot_number", lot_number);
      if (error) {
        console.error("DELETE /api/lots (fan-out): Supabase error", error);
        return NextResponse.json({ error: "Failed to delete lot." }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
