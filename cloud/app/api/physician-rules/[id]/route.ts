import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * PATCH /api/physician-rules/[id] — edits a vaccine/age-range -> physician
 * assignment rule. DELETE removes one. See
 * supabase/migrations/0007_physicians.sql / app/api/physician-rules/route.ts.
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
    const { physician_id, vaccine_id, min_age, max_age, priority } = body ?? {};

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
    const { data, error } = await supabase
      .from("physician_rule")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("PATCH /api/physician-rules/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update physician rule." }, { status: 500 });
    }

    return NextResponse.json({ physicianRule: data });
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
