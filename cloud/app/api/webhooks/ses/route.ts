import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { extractAttachmentFromRawMime, extractTextFromRawMime } from "@/lib/ses-mime";
import { isAllowedSnsHost, verifySnsSignature } from "@/lib/sns-signature";
import { findAddressByToken, parseToken, touchLastReceived, type InboundEmailAddress } from "@/lib/on-hand/address";
import { insertOnHandRows } from "@/lib/on-hand/insert";
import {
  matchPioneerBohRows,
  parseOnHandUpload,
  parsePioneerBohDelimited,
  parsePioneerBohXlsx,
  type MatchedOnHandRow,
} from "@/lib/on-hand/pioneer-boh";
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
 *
 * ACCOUNT ATTRIBUTION (V-onhand-account-address, Will 2026-09-08): a real
 * SES "Received" notification's `receipt.recipients` (falling back to
 * `mail.destination`) names the actual envelope recipient address(es).
 * The router upstream of SNS is being changed to forward every recipient
 * whose local part starts with "vaccines-" here, so this route resolves
 * the FIRST recipient whose token (lib/on-hand/address.ts's parseToken)
 * matches an enabled `inbound_email_address` row, and attaches every
 * inserted on_hand_count row to that account
 * (inbound_email_address_id + last_received_at). An unknown, disabled, or
 * absent token — including the legacy fixed
 * vaccines-onhand@in.orchardsdrug.com address, which isn't a valid token
 * at all — gets a 200 `{ ignored: "unknown-recipient" }` and a
 * console.warn, with NOTHING inserted: never a 4xx/5xx for this case,
 * since SNS retries on failure and a malformed/unrecognized recipient
 * will never become recognized on retry. This resolution only applies to
 * the SNS "Received" path — the legacy simple-contract shape (JSON/text
 * POSTs with no SES envelope at all, used for manual testing) has no
 * recipient to resolve and keeps inserting unattributed rows exactly as
 * before.
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
 * Loads the live vaccine catalog (including `ndc`, for Pioneer-table NDC
 * matching — lib/on-hand/pioneer-boh.ts) or returns a ready-to-send error
 * response, same "return the response, not the data" convention as
 * requireAuthenticatedUser.
 */
async function loadCatalogOrError(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<{ catalog: CatalogVaccine[] } | { error: NextResponse }> {
  const { data, error } = await supabase.from("vaccine").select("id, name, short_code, ndc");
  if (error) {
    console.error("POST /api/webhooks/ses: failed to load vaccine catalog", error);
    return { error: NextResponse.json({ error: "Failed to load vaccine catalog." }, { status: 500 }) };
  }
  return { catalog: data ?? [] };
}

/**
 * Shared tail end of every entry shape (legacy text lines, a Pioneer
 * xlsx/csv attachment): batch-insert already-matched rows into
 * on_hand_count (lib/on-hand/insert.ts — degrades gracefully before
 * supabase/migrations/0011 has added ndc/stock_size) and return the
 * linesTotal/matchedCount/unmatchedCount summary.
 *
 * `addressId`, when given, is stamped onto every inserted row as
 * inbound_email_address_id (the resolved recipient's account — see the
 * ACCOUNT ATTRIBUTION doc comment above). Omitted entirely (not even as
 * `null`) when there's no address to attach, so the legacy
 * simple-contract callers keep inserting the exact same row shape as
 * before this feature existed — inbound_email_address_id then falls back
 * to the column's DB default (NULL, treated as "legacy/unattributed").
 * `source` is deliberately NOT set here (unlike the upload route) — the
 * column's own DB default, 'email', is exactly right for this path.
 */
async function insertAndSummarize(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  rows: MatchedOnHandRow[],
  addressId: string | undefined
): Promise<NextResponse> {
  if (rows.length === 0) {
    console.log("POST /api/webhooks/ses: parse outcome — 0 lines");
    return NextResponse.json({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
  }

  const { error: insertError } = await insertOnHandRows(supabase, rows, { addressId });
  if (insertError) {
    console.error("POST /api/webhooks/ses: failed to insert on_hand_count rows", insertError);
    return NextResponse.json({ error: "Failed to store on-hand counts." }, { status: 500 });
  }

  const matchedCount = rows.filter((row) => row.matched).length;
  console.log(
    `POST /api/webhooks/ses: parse outcome — linesTotal=${rows.length} matchedCount=${matchedCount} unmatchedCount=${rows.length - matchedCount}`
  );
  return NextResponse.json({
    linesTotal: rows.length,
    matchedCount,
    unmatchedCount: rows.length - matchedCount,
  });
}

/**
 * Legacy simple-contract path (and the SNS text/plain fallback): run
 * `content` through the original "VaccineName, Quantity" line parser.
 */
async function processOnHandContent(content: string, addressId?: string): Promise<NextResponse> {
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

  const catalogResult = await loadCatalogOrError(supabase);
  if ("error" in catalogResult) return catalogResult.error;

  // parseOnHandUpload also recognizes a Pioneer-table PASTED into the
  // email body as plain text (not an attachment) via its own header
  // detection — same dispatch the upload route uses, so a body that
  // happens to be the table still gets NDC-matched instead of being
  // treated as garbled "VaccineName, Quantity" lines.
  const rows = parseOnHandUpload({ kind: "text", text: content }, catalogResult.catalog);
  return insertAndSummarize(supabase, rows, addressId);
}

/**
 * V-ordering-targets (Will 2026-09-08): Pioneer's real emailed on-hand
 * report is most likely the SAME table its manual export produces, sent
 * as an xlsx/csv attachment rather than typed into the email body — see
 * lib/ses-mime.ts's extractAttachmentFromRawMime. This path parses that
 * attachment through the same lib/on-hand/pioneer-boh.ts matcher the
 * upload route uses (NDC first, name fallback), rather than
 * extractTextFromRawMime's plain-text search.
 */
async function processOnHandAttachment(
  attachment: { kind: "xlsx"; buffer: Buffer } | { kind: "csv"; text: string },
  addressId: string | undefined
): Promise<NextResponse> {
  let supabase;
  try {
    supabase = getSupabaseServerClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Supabase is not configured." },
      { status: 503 }
    );
  }

  const catalogResult = await loadCatalogOrError(supabase);
  if ("error" in catalogResult) return catalogResult.error;
  const { catalog } = catalogResult;

  const rows =
    attachment.kind === "xlsx"
      ? matchPioneerBohRows(parsePioneerBohXlsx(attachment.buffer), catalog)
      : matchPioneerBohRows(parsePioneerBohDelimited(attachment.text, attachment.text.includes("\t") ? "\t" : ","), catalog);

  return insertAndSummarize(supabase, rows, addressId);
}

/**
 * Pulls candidate recipient address strings out of an SES "Received"
 * notification: `receipt.recipients` (the authoritative envelope
 * recipients — matches the real SMTP RCPT TO) first, falling back to
 * `mail.destination` only when `receipt.recipients` is absent or empty.
 */
function extractRecipients(sesMessage: Record<string, unknown>): string[] {
  const receipt = sesMessage.receipt as Record<string, unknown> | undefined;
  const receiptRecipients = receipt?.recipients;
  if (Array.isArray(receiptRecipients)) {
    const filtered = receiptRecipients.filter((r): r is string => typeof r === "string");
    if (filtered.length > 0) return filtered;
  }

  const mail = sesMessage.mail as Record<string, unknown> | undefined;
  const destination = mail?.destination;
  if (Array.isArray(destination)) {
    return destination.filter((r): r is string => typeof r === "string");
  }

  return [];
}

/**
 * Resolves the first recipient whose token matches an enabled
 * inbound_email_address row, or null if none do (or there are no
 * candidate recipients at all). Throws only when Supabase itself isn't
 * configured (findAddressByToken swallows lookup errors as "no match" —
 * see its own doc comment), matching processOnHandContent's own
 * 503-on-unconfigured posture.
 */
async function resolveRecipientAddress(recipients: string[]): Promise<InboundEmailAddress | null> {
  for (const recipient of recipients) {
    const token = parseToken(recipient);
    if (!token) continue;
    const address = await findAddressByToken(token);
    if (address && address.enabled) return address;
  }
  return null;
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

    const recipients = extractRecipients(sesMessage);
    let resolvedAddress: InboundEmailAddress | null;
    try {
      resolvedAddress = await resolveRecipientAddress(recipients);
    } catch (err) {
      console.error("POST /api/webhooks/ses: failed to resolve recipient address", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Supabase is not configured." },
        { status: 503 }
      );
    }

    if (!resolvedAddress) {
      console.warn(
        `POST /api/webhooks/ses: ignoring SES notification — no enabled recipient token among [${recipients.join(", ")}]`
      );
      return NextResponse.json({ ignored: "unknown-recipient" });
    }

    // V-ordering-targets: try an xlsx/csv ATTACHMENT first (Pioneer's
    // real emailed report is most likely this same table its manual
    // export produces) — extractAttachmentFromRawMime returns null for
    // any message that isn't multipart or has no recognizable xlsx/csv
    // part, so a plain-text on-hand email falls straight through to the
    // existing plain-text path unchanged.
    const attachment = extractAttachmentFromRawMime(rawMime);
    const response = attachment
      ? await processOnHandAttachment(attachment, resolvedAddress.id)
      : await processOnHandContent(extractTextFromRawMime(rawMime), resolvedAddress.id);
    if (response.status === 200) {
      await touchLastReceived(resolvedAddress.id);
    }
    return response;
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
