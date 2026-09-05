import { createVerify, X509Certificate } from "node:crypto";

/**
 * AWS SNS message signature verification — no third-party dependency,
 * per AWS's documented scheme:
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * Mirrors the pattern already in production at
 * ~/claude/clarify/app/api/email-capture/route.ts (same account, same
 * SES->SNS setup) — ported here rather than re-derived, per the brief's
 * "mirroring the existing Clarify pattern" instruction.
 *
 * Restricted to AWS-hosted signing certs only: SigningCertURL must be
 * https and host `sns.<region>.amazonaws.com` (a stricter subset of the
 * "*.amazonaws.com" the brief asks for — there's no reason a legitimate
 * SNS signing cert would ever live anywhere else).
 */

const SNS_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i;

/** Also used by the route to validate SubscribeURL before fetching it —
 * same AWS-hosted-only restriction applies to both URLs. */
export function isAllowedSnsHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && SNS_HOST_PATTERN.test(parsed.hostname);
}

const certCache = new Map<string, { pem: string; expiresAt: number }>();

async function fetchSigningCert(url: string): Promise<string | null> {
  if (!isAllowedSnsHost(url)) return null;

  const cached = certCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const pem = await res.text();
    certCache.set(url, { pem, expiresAt: Date.now() + 60 * 60 * 1000 });
    return pem;
  } catch {
    return null;
  }
}

function buildStringToSign(message: Record<string, unknown>): string | null {
  const type = String(message.Type ?? "");
  let fields: string[];
  if (type === "Notification") {
    fields = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
  } else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  } else {
    return null;
  }

  const lines: string[] = [];
  for (const key of fields) {
    const value = message[key];
    if (value === undefined || value === null) {
      // Subject is optional on Notification messages and is omitted
      // from the signed string entirely when absent.
      if (key === "Subject" && type === "Notification") continue;
      return null;
    }
    lines.push(key);
    lines.push(String(value));
  }
  return lines.join("\n") + "\n";
}

/**
 * Verifies an SNS message envelope's cryptographic signature. Returns
 * false (never throws) for any malformed, unsupported, or unverifiable
 * message — callers should treat that as "reject the request".
 */
export async function verifySnsSignature(message: Record<string, unknown>): Promise<boolean> {
  const signature = message.Signature as string | undefined;
  const certUrl = message.SigningCertURL as string | undefined;
  const signatureVersion = String(message.SignatureVersion ?? "");

  if (!signature || !certUrl) return false;
  if (signatureVersion !== "1" && signatureVersion !== "2") return false;

  const algorithm = signatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";

  const pem = await fetchSigningCert(certUrl);
  if (!pem) return false;

  const stringToSign = buildStringToSign(message);
  if (!stringToSign) return false;

  try {
    const publicKey = new X509Certificate(pem).publicKey;
    const verifier = createVerify(algorithm);
    verifier.update(stringToSign, "utf8");
    return verifier.verify(publicKey, signature, "base64");
  } catch {
    return false;
  }
}
