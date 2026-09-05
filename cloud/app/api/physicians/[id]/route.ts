import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * PATCH /api/physicians/[id] — edits a physician's display name and/or
 * alternate ID from the desktop app's Physicians settings screen.
 * DELETE removes one (physician_rule rows referencing it cascade-delete —
 * see supabase/migrations/0007_physicians.sql's FK).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing physician id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { display_name, alternate_id } = body ?? {};

    const update: Record<string, string> = {};
    if (display_name !== undefined) {
      if (typeof display_name !== "string" || !display_name.trim()) {
        return NextResponse.json({ error: "display_name must be a non-empty string." }, { status: 400 });
      }
      update.display_name = display_name.trim();
    }
    if (alternate_id !== undefined) {
      if (typeof alternate_id !== "string" || !alternate_id.trim()) {
        return NextResponse.json({ error: "alternate_id must be a non-empty string." }, { status: 400 });
      }
      if (/\s/.test(alternate_id)) {
        return NextResponse.json(
          { error: "alternate_id must not contain spaces (Pioneer's own Alternate ID rule)." },
          { status: 400 }
        );
      }
      update.alternate_id = alternate_id.trim();
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("physician")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("PATCH /api/physicians/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update physician." }, { status: 500 });
    }

    return NextResponse.json({ physician: data });
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
    return NextResponse.json({ error: "Missing physician id." }, { status: 400 });
  }

  try {
    const supabase = getSupabaseServerClient();
    const { error } = await supabase.from("physician").delete().eq("id", id);

    if (error) {
      console.error("DELETE /api/physicians/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to delete physician." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
