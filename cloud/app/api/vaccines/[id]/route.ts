import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * PATCH /api/vaccines/[id] — toggles a vaccine's `active` flag from the
 * desktop app's Active vaccines tab, and (V-cloud-tabs, Will 2026-09-05/07)
 * edits its `quantity`/`directions` Pioneer prescription-entry defaults
 * from the same page. Body: { active?: boolean, quantity?: string | null,
 * directions?: string | null } — at least one field required.
 *
 * This is the only write path onto vaccine.active/quantity/directions
 * from the desktop app: the desktop app never holds the Supabase
 * service-role key, only the signed-in user's bearer access token (see
 * lib/auth.ts's requireAuthenticatedUser), so every write goes through
 * this authed cloud route the same way Lots/Scheduling already do.
 *
 * quantity/directions are additive columns
 * (supabase/migrations/0009_lots_bud_vaccine_defaults.sql) that may not
 * exist yet on a given database — see lib/schema-degradation.ts. If the
 * update includes either field and Postgres reports the column doesn't
 * exist, this retries the SAME update with just `active` (dropping the
 * unsupported fields) and returns `quantityDirectionsSupported: false`
 * rather than failing the whole request outright.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing vaccine id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { active, quantity, directions } = body ?? {};

    const update: Record<string, unknown> = {};
    if (active !== undefined) {
      if (typeof active !== "boolean") {
        return NextResponse.json({ error: "active must be a boolean." }, { status: 400 });
      }
      update.active = active;
    }
    if (quantity !== undefined) {
      if (quantity !== null && typeof quantity !== "string") {
        return NextResponse.json({ error: "quantity must be a string or null." }, { status: 400 });
      }
      update.quantity = quantity;
    }
    if (directions !== undefined) {
      if (directions !== null && typeof directions !== "string") {
        return NextResponse.json({ error: "directions must be a string or null." }, { status: 400 });
      }
      update.directions = directions;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    let { data, error } = await supabase.from("vaccine").update(update).eq("id", id).select().single();
    let quantityDirectionsSupported = true;

    if (error && isMissingColumnError(error) && ("quantity" in update || "directions" in update)) {
      quantityDirectionsSupported = false;
      const { quantity: _q, directions: _d, ...withoutQuantityDirections } = update;
      if (Object.keys(withoutQuantityDirections).length === 0) {
        return NextResponse.json(
          { error: "quantity/directions columns are not available yet — the migration hasn't run.", quantityDirectionsSupported },
          { status: 409 }
        );
      }
      ({ data, error } = await supabase
        .from("vaccine")
        .update(withoutQuantityDirections)
        .eq("id", id)
        .select()
        .single());
    }

    if (error) {
      console.error("PATCH /api/vaccines/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update vaccine." }, { status: 500 });
    }

    return NextResponse.json({ vaccine: data, quantityDirectionsSupported });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
