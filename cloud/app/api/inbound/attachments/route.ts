import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { listInboundAttachments } from "@/lib/inbound-attachments";

/**
 * GET /api/inbound/attachments — admin listing of every retained inbound
 * email attachment (V-inbound-attachment-retention, 2026-09-11), newest
 * first, WITHOUT the base64 payload — see
 * app/api/inbound/attachments/[key]/route.ts for downloading one.
 * Authed exactly like every other admin/desktop route in this app
 * (requireAuthenticatedUser — see app/api/vaccines/route.ts); there is
 * no `?secret=` mechanism for this route since none exists for this
 * app's other non-webhook admin routes.
 */
export async function GET(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  try {
    const supabase = getSupabaseServerClient();
    const attachments = await listInboundAttachments(supabase);
    return NextResponse.json({ attachments });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
