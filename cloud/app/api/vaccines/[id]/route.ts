import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * PATCH /api/vaccines/[id] — toggles a vaccine's `active` flag from the
 * desktop app's Active vaccines tab. Body: { active: boolean }.
 *
 * This is the only write path onto vaccine.active from the desktop app:
 * the desktop app never holds the Supabase service-role key, only the
 * signed-in user's bearer access token (see lib/auth.ts's
 * requireAuthenticatedUser), so every write goes through this authed
 * cloud route the same way Lots/Scheduling already do.
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
    const { active } = body ?? {};

    if (typeof active !== "boolean") {
      return NextResponse.json({ error: "active must be a boolean." }, { status: 400 });
    }

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("vaccine")
      .update({ active })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("PATCH /api/vaccines/[id]: Supabase error", error);
      return NextResponse.json({ error: "Failed to update vaccine." }, { status: 500 });
    }

    return NextResponse.json({ vaccine: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
