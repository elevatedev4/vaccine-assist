/**
 * Minimal raw-MIME plain-text extractor for SES-via-SNS inbound email
 * (V-ordering SNS upgrade, 2026-09). No external MIME dependency — the
 * on-hand emails we care about are simple, so a small careful parser
 * covers the cases that matter and documents what it deliberately
 * doesn't handle, rather than pulling in a general-purpose MIME library
 * for three cases.
 *
 * Handles:
 *   (a) A simple, non-multipart `text/plain` message.
 *   (b) `multipart/alternative` (or any single-level multipart/*) —
 *       the first `text/plain` part found is used.
 *   (c) `quoted-printable` and `base64` Content-Transfer-Encoding, at
 *       both the top level and within a part.
 *
 * Deliberately does NOT handle:
 *   - Attachments (non-text parts are skipped, never inspected).
 *   - Multipart nested more than one level deep. Rather than recursing
 *     (unbounded complexity for a case we don't expect from these
 *     pharmacy on-hand emails) or silently returning nothing, this
 *     parser falls back to the FULL raw MIME text in that case — and
 *     in every other "couldn't confidently find a text/plain part"
 *     case below — so the content still lands as an on_hand_count row
 *     (unmatched, ready for manual review) instead of vanishing.
 */

const HEADER_BODY_SEPARATORS = ["\r\n\r\n", "\n\n"];

function splitHeaderBody(raw: string): { headers: string; body: string } | null {
  for (const sep of HEADER_BODY_SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) {
      return { headers: raw.slice(0, idx), body: raw.slice(idx + sep.length) };
    }
  }
  return null;
}

/** Reads a header value, unfolding RFC 2822 continuation lines (lines
 * starting with whitespace) into a single space-joined string. */
function getHeader(headers: string, name: string): string | undefined {
  const pattern = new RegExp(`^${name}:\\s*([^\\r\\n]+(?:\\r?\\n[ \\t]+[^\\r\\n]+)*)`, "im");
  const match = headers.match(pattern);
  return match ? match[1].replace(/\s+/g, " ").trim() : undefined;
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeByTransferEncoding(body: string, encoding: string): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  if (enc === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  // 7bit / 8bit / binary / unspecified — used as-is.
  return body;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitMultipartParts(body: string, boundary: string): string[] {
  const escaped = escapeForRegExp(boundary);
  return body
    .split(new RegExp(`--${escaped}(?:--)?`))
    .filter((part) => part.trim().length > 0 && part.trim() !== "--");
}

function extractBoundary(contentTypeHeaderValue: string): string | undefined {
  const match = contentTypeHeaderValue.match(/boundary="?([^";\r\n\s]+)"?/i);
  return match?.[1];
}

/**
 * Extracts the plain-text body from a raw MIME email string (the
 * already-base64-decoded SES `content` field). See module doc comment
 * for exactly which shapes are handled vs. fall back to returning the
 * full raw text unmodified.
 */
export function extractTextFromRawMime(raw: string): string {
  const trimmedRaw = raw.trim();
  const top = splitHeaderBody(raw);
  if (!top) return trimmedRaw;

  const contentTypeRaw = getHeader(top.headers, "Content-Type") ?? "text/plain";
  const contentType = contentTypeRaw.toLowerCase();

  if (!contentType.includes("multipart")) {
    const encoding = getHeader(top.headers, "Content-Transfer-Encoding") ?? "";
    const decoded = decodeByTransferEncoding(top.body, encoding).replace(/\r\n/g, "\n").trim();
    return decoded || trimmedRaw;
  }

  // Boundary tokens are case-sensitive and appear verbatim (not
  // lowercased) as `--<boundary>` markers in the body, so it's extracted
  // from the ORIGINAL-case header value, not the lowercased `contentType`
  // used for the multipart/text-type checks above/below.
  const boundary = extractBoundary(contentTypeRaw);
  if (!boundary) return trimmedRaw;

  for (const part of splitMultipartParts(top.body, boundary)) {
    const partSplit = splitHeaderBody(part);
    if (!partSplit) continue;

    const partContentType = (getHeader(partSplit.headers, "Content-Type") ?? "text/plain").toLowerCase();

    if (partContentType.includes("multipart")) {
      // Nested multipart beyond the one level this parser handles —
      // fall back to the full raw text rather than recursing or dropping.
      return trimmedRaw;
    }

    if (partContentType.includes("text/plain")) {
      const partEncoding = getHeader(partSplit.headers, "Content-Transfer-Encoding") ?? "";
      const decoded = decodeByTransferEncoding(partSplit.body, partEncoding).replace(/\r\n/g, "\n").trim();
      if (decoded) return decoded;
    }
    // Any other part content-type (text/html, image/*, application/*, ...)
    // is skipped — attachments are never inspected.
  }

  // No usable text/plain part found at this level (e.g. an HTML-only
  // multipart/alternative) — fall back to the raw text for review.
  return trimmedRaw;
}
