import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { isMissingColumnError } from "@/lib/schema-degradation";

/**
 * PATCH /api/physician-rules/[id] — edits a vaccine/age-range -> physician
 * assignment rule. DELETE removes one. See
 * supabase/migrations/0007_physicians.sql / app/api/physician-rules/route.ts.
 *
 * V-cloud-tabs (Will, 2026-09-05/07): also edits `vaccine_group`
 * (mutually exclusive with vaccine_id — validated below), degrading the
 * same way as the POST route's insert if that column doesn't exist yet.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing physician rule id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { physician_id, vaccine_id, vaccine_group, min_age, max_age, priority } = body ?? {};

    const update: Record<string, string | number | null> = {};
    if (physician_id !== undefined) {
      if (typeof physician_id !== "string" || !physician_id) {
        return NextResponse.json({ error: "physician_id must be a non-empty string." }, { status: 400 });
      }
      update.physician_id = physician_id;
    }
    if (vaccine_id !== undefined) {
      if (vaccine_id !== null && typeof vaccine_id !== "string") {
        return NextResponse.json({ error: "vaccine_id must be a string or null." }, { status: 400 });
      }
      update.vaccine_id = vaccine_id;
    }
    if (vaccine_group !== undefined) {
      if (vaccine_group !== null && typeof vaccine_group !== "string") {
        return NextResponse.json({ error: "vaccine_group must be a string or null." }, { status: 400 });
      }
      update.vaccine_group = vaccine_group;
    }
    if ((update.vaccine_id ?? null) !== null && (update.vaccine_group ?? null) !== null) {
      return NextResponse.json(
        { error: "A rule may target a specific vaccine_id OR a vaccine_group, not both." },
        { status: 400 }
      );
    }
    if (min_age !== undefined) {
      if (min_age !== null && typeof min_age !== "number") {
        return NextResponse.json({ error: "min_age must be a number or null." }, { status: 400 });
      }
      update.min_age = min_age;
    }
    if (max_age !== undefined) {
      if (max_age !== null && typeof max_age !== "number") {
        return NextResponse.json({ error: "max_age must be a number or null." }, { status: 400 });
      }
      update.max_age = max_age;
    }
    if (priority !== undefined) {
      if (typeof priority !== "number") {
        return NextResponse.json({ error: "priority must be a number." }, { status: 400 });
      }
      update.priority = priority;
    }

    if (
      typeof update.min_age === "number" &&
      typeof update.max_age === "number" &&
      update.min_age > update.max_age
    ) {
      return NextResponse.json({ error: "min_age must not be greater than max_age." }, { status: 400 });
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    let { data, error } = await supabase.from("physician_rule").update(update).eq("id", id).select().single();
    let vaccineGroupSupported = true;

    if (error && isMissingColumnError(error) && "vaccine_group" in update) {
      vaccineGroupSupported = false;
      if (update.vaccine_group !== null) {
        return NextResponse.json(
          { error: "vaccine_group is not available yet — the migration hasn't run.", vaccineGroupSupported },
          { status: 409 }
        );
      }
      const { vaccine_group: _vg, ...withoutVaccineGroup } = update;
      if (Object.keys(withoutVaccineGroup).length === 0) {
        return NextResponse.json({ error: "Nothing to update.", vaccineGroupSupported }, { status: 400 });
      }
      ({ data, error } = await supabase
        .from("physician_rule")
        .update(withoutVaccineGroup)
        .eq("id", id)
        .select()
        .single());
    }

    if (error) {
      console.error("PATCH /api/physician-rules/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update physician rule." }, { status: 500 });
    }

    return NextResponse.json({ physicianRule: data, vaccineGroupSupported });
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
    return NextResponse.json({ error: "Missing physician rule id." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.from("physician_rule").delete().eq("id", id);

    if (error) {
      console.error("DELETE /api/physician-rules/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to delete physician rule." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
