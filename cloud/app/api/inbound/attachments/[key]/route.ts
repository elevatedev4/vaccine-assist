import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getInboundAttachmentByKey } from "@/lib/inbound-attachments";

/**
 * GET /api/inbound/attachments/[key] — streams one retained inbound
 * email attachment's decoded bytes (V-inbound-attachment-retention,
 * 2026-09-11), for pulling a report Vercel logs show was retained but
 * not recognized (e.g. the "Completed date" vaccination-log report).
 * `key` is the app_setting key, URL-encoded by the caller (it contains
 * ":" — see lib/inbound-attachments.ts's buildAttachmentKey). Authed
 * exactly like GET /api/inbound/attachments (requireAuthenticatedUser) —
 * no separate `?secret=` mechanism, matching every other admin route in
 * this app.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);

  try {
    const supabase = getSupabaseServerClient();
    const attachment = await getInboundAttachmentByKey(supabase, key);
    if (!attachment) {
      return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    }

    const bytes = Buffer.from(attachment.base64, "base64");
    const safeFilename = attachment.filename.replace(/"/g, "");
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": attachment.contentType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }
}
