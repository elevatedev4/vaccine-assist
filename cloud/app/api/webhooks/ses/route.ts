import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * STUB — SES inbound email webhook.
 *
 * Real plan (phase 2+): SES receipt rule delivers inbound mail
 * notifications here (e.g. an SNS-forwarded message), validated against
 * SES_WEBHOOK_SECRET, then parsed for whatever report/attachment this
 * pharmacy needs ingested automatically. No shape is finalized yet.
 *
 * Phase 1: validates the shared-secret header if configured and logs
 * that a webhook fired; does not parse or store anything.
 */
export async function POST(request: Request) {
  const secret = env.sesWebhookSecret();

  if (secret) {
    const provided = request.headers.get("x-ses-webhook-secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Invalid webhook secret." }, { status: 401 });
    }
  }

  // TODO(phase 2): parse the SES/SNS notification body and process it.
  return NextResponse.json({
    stub: true,
    message: "SES webhook received but not processed — phase 1 stub.",
  });
}
