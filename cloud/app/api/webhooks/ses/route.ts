import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { parseOnHandContent } from "@/lib/on-hand-parser";
import { extractTextFromRawMime } from "@/lib/ses-mime";
import { isAllowedSnsHost, verifySnsSignature } from "@/lib/sns-signature";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

/**
 * SES inbound-email webhook — on-hand stock ingestion (V-ordering,
 * 2026-08-19/20; SNS upgrade 2026-09-04/05).
 *
 * Machine-to-machine inbound webhook, NOT a user-facing endpoint.
 *
 * Real infra (mirrors ~/claude/clarify's SES->SNS setup on the same AWS
 * account): SES receipt rule for vaccines-onhand@capture.orchardsdrug.com
 * -> SNS topic -> HTTPS subscription POSTing here. This route accepts
 * TWO request shapes on the same POST handler:
 *
 *   1. The original "simple contract" (still fully supported — existing
 *      tests cover it, nothing upstream of SNS needs to change):
 *      - Content-Type: application/json with { "text": "..." } (or the
 *        { "body": "..." } alias key), or
 *      - Content-Type: text/plain (or anything else) — the raw request
 *        body text is the content directly.
 *      Auth: `x-ses-webhook-secret` header OR `?secret=` query param
 *      (see isAuthorized below), compared against SES_WEBHOOK_SECRET.
 *
 *   2. Real SNS-over-HTTPS posts, detected by the presence of the
 *      `x-amz-sns-message-type` header SNS always sends:
 *      - SubscriptionConfirmation: confirmed by server-side GET to
 *        SubscribeURL, ONLY once the message's signature verifies and
 *        its TopicArn matches SES_SNS_TOPIC_ARN (see isTopicArnAllowed
 *        for the bootstrapping exception when that env var is unset).
 *      - Notification: TopicArn + signature checked the same way, then
 *        the envelope's `Message` field (a JSON string) is parsed as an
 *        SES receipt notification. Only notificationType "Received" is
 *        processed; `mail.commonHeaders`/etc. are ignored — the on-hand
 *        parser only needs the plain-text body, extracted from the
 *        base64 raw MIME `content` field by lib/ses-mime.ts.
 *      Auth: SNS can't send custom headers, so the header check above
 *      doesn't apply — the `?secret=` query param (baked into the HTTPS
 *      endpoint URL given to SNS at subscribe time) is the credential,
 *      PLUS the topic-ARN check and cryptographic signature verification
 *      above. See lib/sns-signature.ts for why full signature
 *      verification was worth implementing (AWS's scheme is
 *      straightforward with node:crypto, and it was already working
 *      code to port from Clarify) rather than skipped.
 *
 * Both shapes converge on the exact same path: the extracted content
 * string goes through lib/on-hand-parser.ts (parseOnHandContent) against
 * the current `vaccine` catalog, and every parsed line (matched AND
 * unmatched — nothing is dropped) is inserted into `on_hand_count`
 * (supabase/migrations/0006_on_hand_counts.sql) in one batch insert —
 * see processOnHandContent.
 *
 * PHI/log discipline: only message-type, topic ARN, and parse-outcome
 * line counts are logged (at most). Never the email body/content itself.
 */

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Constant-time compare requires equal-length buffers; a length
  // mismatch is itself safe to short-circuit on (it leaks only length,
  // not content) and avoids timingSafeEqual throwing on mismatched sizes.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True when no secret is configured (existing open-by-default behavior,
 * unchanged) or when either the `x-ses-webhook-secret` header or a
 * `?secret=` query param matches SES_WEBHOOK_SECRET via a constant-time
 * compare. The query-param form exists because SNS HTTPS subscriptions
 * can't be made to send a custom header — the secret goes in the
 * subscribed URL instead.
 */
function isAuthorized(request: Request): boolean {
  const secret = env.sesWebhookSecret();
  if (!secret) return true;

  const header = request.headers.get("x-ses-webhook-secret");
  if (header !== null && safeCompare(header, secret)) return true;

  const queryParam = new URL(request.url).searchParams.get("secret");
  if (queryParam !== null && safeCompare(queryParam, secret)) return true;

  return false;
}

/**
 * True when `topicArn` matches SES_SNS_TOPIC_ARN, OR that env var isn't
 * set yet. The unset case is a deliberate bootstrapping tradeoff: Will
 * can't put a topic ARN in the app's env vars before the topic exists,
 * and the topic/subscription get created AFTER this route is deployed
 * (SNS needs a live HTTPS endpoint to confirm against). So immediately
 * after this ships, SNS traffic is accepted on signature + URL-secret
 * alone; once he sets SES_SNS_TOPIC_ARN post-deploy, this tightens to
 * also require the exact topic. Every acceptance in the unset case is
 * logged as a warning so it's visible this gap is still open.
 */
function isTopicArnAllowed(topicArn: string | undefined): boolean {
  const expected = env.sesSnsTopicArn();
  if (!expected) {
    console.warn(
      "POST /api/webhooks/ses: SES_SNS_TOPIC_ARN is not set — accepting SNS message without a topic-ARN restriction (bootstrapping allowance, see route.ts doc comment)"
    );
    return true;
  }
  return topicArn === expected;
}

async function extractLegacyContent(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await request.json();
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.body === "string") return record.body;
      }
      return "";
    } catch {
      // Malformed JSON despite the declared content-type — treat as empty
      // rather than throwing; the summary response below still tells the
      // caller nothing was ingested.
      return "";
    }
  }

  try {
    return await request.text();
  } catch {
    return "";
  }
}

/**
 * Shared tail end of both entry shapes: run `content` through the
 * on-hand parser against the live vaccine catalog and batch-insert every
 * line (matched or not) into on_hand_count.
 */
async function processOnHandContent(content: string): Promise<NextResponse> {
  if (!content || content.trim().length === 0) {
    console.log("POST /api/webhooks/ses: empty content, nothing to parse");
    return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
  }

  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const { data: catalogData, error: catalogError } = await supabase
    .from("vaccine")
    .select("id, name, short_code");

  if (catalogError) {
    console.error("POST /api/webhooks/ses: failed to load vaccine catalog", catalogError);
    return NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 });
  }

  const catalog: CatalogVaccine[] = catalogData ?? [];
  const parsed = parseOnHandContent(content, catalog);

  if (parsed.length === 0) {
    console.log("POST /api/webhooks/ses: parse outcome — 0 lines");
    return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
  }

  const rows = parsed.map((line) => ({
    raw_line: line.rawLine,
    vaccine_name_raw: line.vaccineNameRaw,
    quantity: line.quantity,
    vaccine_id: line.vaccineId,
    matched: line.matched,
  }));

  const { error: insertError } = await supabase.from("on_hand_count").insert(rows);
  if (insertError) {
    console.error("POST /api/webhooks/ses: failed to insert on_hand_count rows", insertError);
    return NextResponse.json({ error: "Failed to store on-hand counts." }, { status: 500 });
  }

  const matchedCount = parsed.filter((line) => line.matched).length;
  console.log(
    `POST /api/webhooks/ses: parse outcome — linesTotal=${parsed.length} matchedCount=${matchedCount} unmatchedCount=${parsed.length - matchedCount}`
  );
  return NextResponse.json({
    linesTotal: parsed.length,
    matchedCount,
    unmatchedCount: parsed.length - matchedCount,
  });
}

async function handleSnsRequest(request: Request, snsMessageType: string): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    console.warn("POST /api/webhooks/ses: SNS payload was not valid JSON");
    return NextResponse.json({ error: "Malformed SNS payload." }, { status: 400 });
  }

  const topicArn = typeof body.TopicArn === "string" ? body.TopicArn : undefined;
  console.log(`POST /api/webhooks/ses: SNS message received — type=${snsMessageType} topic=${topicArn ?? "(none)"}`);

  if (!isTopicArnAllowed(topicArn)) {
    console.warn(`POST /api/webhooks/ses: rejecting SNS message — topic ARN did not match SES_SNS_TOPIC_ARN`);
    return NextResponse.json({ error: "Topic ARN not allowed." }, { status: 403 });
  }

  const signatureValid = await verifySnsSignature(body);
  if (!signatureValid) {
    console.warn("POST /api/webhooks/ses: rejecting SNS message — signature verification failed");
    return NextResponse.json({ error: "Invalid SNS signature." }, { status: 403 });
  }

  if (snsMessageType === "SubscriptionConfirmation") {
    const subscribeUrl = typeof body.SubscribeURL === "string" ? body.SubscribeURL : undefined;
    if (!subscribeUrl || !isAllowedSnsHost(subscribeUrl)) {
      console.warn("POST /api/webhooks/ses: refusing to confirm subscription — missing/disallowed SubscribeURL host");
      return NextResponse.json({ error: "SubscribeURL missing or host not allowed." }, { status: 400 });
    }
    try {
      const confirmResponse = await fetch(subscribeUrl);
      console.log(`POST /api/webhooks/ses: subscription confirmation fetch completed — status=${confirmResponse.status}`);
    } catch (err) {
      console.error("POST /api/webhooks/ses: subscription confirmation fetch threw", err);
      return NextResponse.json({ error: "Failed to confirm subscription." }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  }

  if (snsMessageType === "Notification") {
    let sesMessage: Record<string, unknown>;
    try {
      sesMessage = JSON.parse(String(body.Message ?? "")) as Record<string, unknown>;
    } catch {
      console.warn("POST /api/webhooks/ses: SNS Notification's Message field was not valid JSON");
      return NextResponse.json({ error: "Malformed SES notification." }, { status: 400 });
    }

    if (sesMessage.notificationType !== "Received") {
      console.log(`POST /api/webhooks/ses: ignoring SES notificationType=${String(sesMessage.notificationType)}`);
      return NextResponse.json({ ok: true });
    }

    const rawContentB64 = typeof sesMessage.content === "string" ? sesMessage.content : "";
    if (!rawContentB64) {
      console.warn("POST /api/webhooks/ses: SES 'Received' notification had no content field (email > 150KB?)");
      return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
    }

    let rawMime: string;
    try {
      rawMime = Buffer.from(rawContentB64, "base64").toString("utf-8");
    } catch {
      console.warn("POST /api/webhooks/ses: failed to base64-decode SES content field");
      return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
    }

    const content = extractTextFromRawMime(rawMime);
    return processOnHandContent(content);
  }

  // UnsubscribeConfirmation or any future SNS message type — acknowledge
  // with 200 so SNS doesn't retry; nothing for this route to do with it.
  console.log(`POST /api/webhooks/ses: acknowledging unhandled SNS message type=${snsMessageType}`);
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Invalid webhook secret." }, { status: 401 });
  }

  const snsMessageType = request.headers.get("x-amz-sns-message-type");
  if (snsMessageType) {
    return handleSnsRequest(request, snsMessageType);
  }

  const content = await extractLegacyContent(request);
  return processOnHandContent(content);
}
