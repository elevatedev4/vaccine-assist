import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { INBOUND_ATTACHMENT_KEY_PREFIX, getInboundAttachmentByKey } from "@/lib/inbound-attachments";

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
 *
 * SECURITY (review fix, 2026-09-11): `app_setting` is a SHARED table
 * (also holds ordering.walk_in_pct, lots.bud_enabled_products, ...), so
 * this route refuses ANY key that doesn't carry the
 * `inbound_attachment:` prefix with a 404 BEFORE ever touching Supabase
 * — belt-and-suspenders alongside getInboundAttachmentByKey's own same
 * check, so an authenticated caller can never read an unrelated setting
 * row through this download endpoint.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  const { key: rawKey } = await params;

  // Review fix (2026-09-11): a malformed %-escape (e.g. "%E0%A4%A") makes
  // decodeURIComponent throw URIError — treat that exactly like an
  // unrecognized key (404) rather than letting it become an uncaught 500,
  // and BEFORE the prefix check / any Supabase access below.
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  if (!key.startsWith(INBOUND_ATTACHMENT_KEY_PREFIX)) {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

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
