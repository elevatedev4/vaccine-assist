import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";

/**
 * REST endpoint for the desktop app's Physicians settings screen. GET
 * lists every protocol physician on file. POST adds one (display name +
 * the Pioneer "alternate ID" from that physician's own Pioneer profile —
 * see supabase/migrations/0007_physicians.sql).
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("physician")
      .select("*")
      .order("display_name", { ascending: true });

    if (error) {
      console.error("GET /api/physicians: Supabase error", error);
      return NextResponse.json({ error: "Failed to load physicians." }, { status: 500 });
    }

    return NextResponse.json({ physicians: data });
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
    const body = await request.json();
    const { display_name, alternate_id } = body ?? {};

    if (typeof display_name !== "string" || !display_name.trim()) {
      return NextResponse.json({ error: "display_name is required." }, { status: 400 });
    }
    if (typeof alternate_id !== "string" || !alternate_id.trim()) {
      return NextResponse.json({ error: "alternate_id is required." }, { status: 400 });
    }
    if (/\s/.test(alternate_id)) {
      return NextResponse.json(
        { error: "alternate_id must not contain spaces (Pioneer's own Alternate ID rule)." },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
      .from("physician")
      .insert({ display_name: display_name.trim(), alternate_id: alternate_id.trim() })
      .select()
      .single();

    if (error) {
      // Postgres unique_violation (physician_alternate_id_key, see
      // supabase/migrations/0007_physicians.sql) — surfaced as a clear
      // 409 instead of a generic 500, same reasoning as any other
      // "this already exists" conflict.
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `A physician with alternate ID "${alternate_id.trim()}" already exists.` },
          { status: 409 }
        );
      }

      console.error("POST /api/physicians: Supabase error", error);
      return NextResponse.json({ error: "Failed to create physician." }, { status: 500 });
    }

    return NextResponse.json({ physician: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
