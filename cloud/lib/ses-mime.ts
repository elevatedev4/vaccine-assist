/**
 * Minimal raw-MIME extractor for SES-via-SNS inbound email (V-ordering SNS
 * upgrade, 2026-09; recursive-multipart/filename-encoding fix, 2026-09-09
 * — PioneerRx's real "AppExport: Vaccine BOH" email came through as
 * `linesTotal=1 matchedCount=0` with the attachment never even reaching
 * the size-gate warning, meaning `extractAttachmentFromRawMime` returned
 * null: the attachment part was either nested inside a second multipart
 * layer, an unrecognized type, or had an RFC 2231/2047-encoded filename
 * the old single-level parser/regexes missed). No external MIME
 * dependency — the on-hand emails we care about are simple, so a small
 * careful parser covers the cases that matter and documents what it
 * deliberately doesn't handle, rather than pulling in a general-purpose
 * MIME library.
 *
 * Handles:
 *   (a) A simple, non-multipart `text/plain` message.
 *   (b) `multipart/*` nested up to MAX_MIME_DEPTH levels deep (mixed ->
 *       alternative -> related, etc.) — the first recognizable
 *       attachment (extractAttachmentFromRawMime) or `text/plain` part
 *       (extractTextFromRawMime, falling back to a stripped `text/html`
 *       part when no `text/plain` part exists) found by a depth-first
 *       walk is used.
 *   (c) `quoted-printable` and `base64` Content-Transfer-Encoding, at
 *       both the top level and within a part.
 *   (d) Attachment filenames as `Content-Disposition: filename=`,
 *       RFC 2231 `filename*=utf-8''...` (percent-encoded, charset
 *       prefix stripped), RFC 2047 `=?utf-8?Q?...?=` / `?B?` encoded
 *       words, or a bare `name=` on Content-Type — all case-insensitive.
 *   (e) Legacy `.xls` (`application/vnd.ms-excel` or a `.xls` filename)
 *       through the same path as `.xlsx` — SheetJS's `read()` (used by
 *       lib/on-hand/pioneer-boh.ts's parsePioneerBohXlsx) handles both
 *       formats from the same Buffer.
 *   (f) `application/pdf` (or a `.pdf` filename, which is how
 *       PioneerRx's real BOH export actually arrives — as
 *       `application/octet-stream` with a `.pdf` filename, same as the
 *       `.xlsx`-filename-with-octet-stream-type case above) — returned
 *       as `{ kind: "pdf", buffer }` for
 *       lib/on-hand/pioneer-boh-pdf.ts's parsePioneerBohPdf to extract
 *       the table from glyph positions (a PDF has no cell structure
 *       SheetJS-style parsing can use).
 *
 * Deliberately does NOT handle:
 *   - Nesting beyond MAX_MIME_DEPTH levels (a container part that deep
 *     is treated as an opaque leaf rather than expanded further —
 *     bounds the work done on an adversarial/malformed message).
 *   - Attachment types other than xlsx/xls/csv/tsv/pdf (logged via
 *     `console.warn` — see extractAttachmentFromRawMime — and skipped,
 *     never inspected).
 *   - RFC 2231 continuation parameters (`filename*0*=`, `filename*1*=`,
 *     ...) — only the single-segment `filename*=` form.
 *   Every "couldn't confidently find a text/plain part" case falls back
 *   to the FULL raw MIME text (after exhausting the html-stripped
 *   fallback) so the content still lands as an on_hand_count row
 *   (unmatched, ready for manual review) instead of vanishing.
 */

import { MAX_UPLOAD_BYTES } from "@/lib/on-hand/upload";

const HEADER_BODY_SEPARATORS = ["\r\n\r\n", "\n\n"];

export function splitHeaderBody(raw: string): { headers: string; body: string } | null {
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
export function getHeader(headers: string, name: string): string | undefined {
  const pattern = new RegExp(`^${name}:\\s*([^\\r\\n]+(?:\\r?\\n[ \\t]+[^\\r\\n]+)*)`, "im");
  const match = headers.match(pattern);
  return match ? match[1].replace(/\s+/g, " ").trim() : undefined;
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function decodeByTransferEncoding(body: string, encoding: string): string {
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

export function splitMultipartParts(body: string, boundary: string): string[] {
  const escaped = escapeForRegExp(boundary);
  return body
    .split(new RegExp(`--${escaped}(?:--)?`))
    .filter((part) => part.trim().length > 0 && part.trim() !== "--");
}

export function extractBoundary(contentTypeHeaderValue: string): string | undefined {
  const match = contentTypeHeaderValue.match(/boundary="?([^";\r\n\s]+)"?/i);
  return match?.[1];
}

/**
 * Max multipart nesting depth walked by collectMimeParts/describeMimeStructure
 * below. The top-level part is depth 0; a multipart part at depth
 * MAX_MIME_DEPTH is treated as an opaque leaf (not expanded further)
 * rather than recursed into — bounds the work done on a
 * malformed/adversarial message rather than recursing unboundedly.
 */
const MAX_MIME_DEPTH = 4;

type MimeLeaf = {
  headers: string;
  body: string;
  /** Full Content-Type header value, original case (needed for the
   * `name=` filename fallback and for XLSX/CSV pattern matching, which
   * are already case-insensitive via the /i flag). */
  contentTypeRaw: string;
  /** Same value, lowercased, for cheap `.includes()` checks. */
  contentType: string;
};

/**
 * Depth-first walk of a MIME part tree: recurses into `multipart/*`
 * parts (up to MAX_MIME_DEPTH) and appends every non-multipart (or
 * depth-capped) part to `out`, in document order — so "first match
 * wins" scans over `out` still prefer earlier/shallower parts exactly
 * as a single-level scan did before this recursion existed.
 */
function collectMimeParts(headers: string, body: string, depth: number, out: MimeLeaf[]): void {
  const contentTypeRaw = getHeader(headers, "Content-Type") ?? "text/plain";
  const contentType = contentTypeRaw.toLowerCase();

  if (contentType.includes("multipart") && depth < MAX_MIME_DEPTH) {
    const boundary = extractBoundary(contentTypeRaw);
    if (boundary) {
      for (const rawPart of splitMultipartParts(body, boundary)) {
        const split = splitHeaderBody(rawPart);
        if (!split) continue;
        collectMimeParts(split.headers, split.body, depth + 1, out);
      }
      return;
    }
  }

  out.push({ headers, body, contentTypeRaw, contentType });
}

/**
 * Structure-only debug log lines for a raw MIME message — one line per
 * part (recursive, depth-first, same walk as collectMimeParts), NEVER
 * including part bodies or any header beyond Content-Type /
 * Content-Disposition filename / Content-Transfer-Encoding (PHI/log
 * discipline — see the SES webhook route's doc comment). Used to see
 * exactly what a real Pioneer email's MIME tree looks like when
 * extraction fails, without ever logging its content.
 */
export function describeMimeStructure(raw: string): string[] {
  const top = splitHeaderBody(raw);
  if (!top) return [];
  const lines: string[] = [];
  describeMimeNode(top.headers, top.body, 0, 0, lines);
  return lines;
}

function describeMimeNode(headers: string, body: string, depth: number, idx: number, lines: string[]): void {
  const contentTypeRaw = getHeader(headers, "Content-Type") ?? "text/plain";
  const contentType = contentTypeRaw.toLowerCase();
  const filename = getAttachmentFilename(headers, contentTypeRaw);
  const encoding = getHeader(headers, "Content-Transfer-Encoding") ?? "";
  const typeForLog = contentTypeRaw.split(";")[0].trim();

  const fields = [`depth=${depth}`, `idx=${idx}`, `type=${typeForLog}`];
  if (filename) fields.push(`name="${filename}"`);
  if (encoding) fields.push(`enc=${encoding}`);
  fields.push(`bodyChars=${body.length}`);
  lines.push(`mime part ${fields.join(" ")}`);

  if (contentType.includes("multipart") && depth < MAX_MIME_DEPTH) {
    const boundary = extractBoundary(contentTypeRaw);
    if (boundary) {
      splitMultipartParts(body, boundary).forEach((rawPart, childIdx) => {
        const split = splitHeaderBody(rawPart);
        if (!split) return;
        describeMimeNode(split.headers, split.body, depth + 1, childIdx, lines);
      });
    }
  }
}

const XLSX_CONTENT_TYPE_PATTERN = /vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel/i;
const XLSX_FILENAME_PATTERN = /\.xlsx?$/i;
const CSV_CONTENT_TYPE_PATTERN = /text\/csv/i;
const CSV_FILENAME_PATTERN = /\.(csv|tsv)$/i;
/** PDF attachment recognition (V-boh-pdf-attachment, 2026-09-09) —
 * PioneerRx's real "AppExport: Vaccine BOH" email attaches a PDF as
 * `application/octet-stream` with a `.pdf` filename (never
 * `application/pdf`), so the filename pattern is the one that actually
 * matches in production; the content-type pattern is kept for a sender
 * that DOES set it correctly. */
const PDF_CONTENT_TYPE_PATTERN = /application\/pdf/i;
const PDF_FILENAME_PATTERN = /\.pdf$/i;

/**
 * Upper bound on an attachment part's RAW (still-encoded) text length,
 * checked BEFORE any decode/parse work — security review fix,
 * V-ordering-targets (2026-09-08): this webhook is reachable by anyone
 * who learns a per-account inbound address, and xlsx attachments are
 * handed to SheetJS's read() (lib/on-hand/pioneer-boh.ts's
 * parsePioneerBohXlsx), which as of xlsx@0.18.5 carries two open
 * high-severity advisories (GHSA-4r6h-8v6p-xvw6 prototype pollution,
 * GHSA-5pgg-2g8v-p4x9 ReDoS). Base64 encodes 3 bytes as 4 characters, so
 * this is the base64-TEXT length equivalent to MAX_UPLOAD_BYTES decoded
 * bytes — the same 2 MB cap the upload route enforces
 * (lib/on-hand/upload.ts), applied here to both xlsx (base64) and csv/tsv
 * (any encoding — a conservative-but-cheap single threshold covers
 * quoted-printable/base64/plain alike, since none of those encodings
 * shrink the raw part below its decoded size).
 */
export const MAX_ATTACHMENT_PART_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3);

/** RFC 2231 extended-parameter value, e.g. `utf-8''Vaccine%20BOH.xlsx` —
 * strips the leading `charset'language'` prefix (if present) and
 * percent-decodes the rest. Continuation segments (`filename*0*=`, ...)
 * are NOT handled — only the single-segment `filename*=` form. */
function decodeRfc2231Value(value: string): string {
  let v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
  const withoutCharset = v.replace(/^[^']*'[^']*'/, "");
  try {
    return decodeURIComponent(withoutCharset);
  } catch {
    return withoutCharset;
  }
}

/** RFC 2047 encoded-word(s), e.g. `=?utf-8?Q?Vaccine=20BOH.xlsx?=` or
 * `=?utf-8?B?...base64...?=` — decodes the simple single-word Q/B forms
 * (no adjacent-word whitespace folding beyond what's already literal). */
function decodeRfc2047Value(value: string): string {
  return value.replace(/=\?[^?]+\?([QqBb])\?([^?]*)\?=/g, (_match, enc: string, text: string) => {
    if (enc.toLowerCase() === "b") {
      try {
        return Buffer.from(text, "base64").toString("utf-8");
      } catch {
        return text;
      }
    }
    return text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  });
}

/**
 * Attachment filename for a MIME part, checked in priority order (all
 * case-insensitive):
 *   1. `Content-Disposition: filename*=` (RFC 2231) or `Content-Type: name*=`
 *   2. `Content-Disposition: filename=` (optionally RFC 2047-encoded) or
 *      `Content-Type: name=`
 * Returns "" when neither header carries a filename.
 */
function getAttachmentFilename(headers: string, contentTypeRaw: string): string {
  const disposition = getHeader(headers, "Content-Disposition") ?? "";

  const starMatch = disposition.match(/filename\*\s*=\s*([^;\r\n]+)/i) ?? contentTypeRaw.match(/name\*\s*=\s*([^;\r\n]+)/i);
  if (starMatch) return decodeRfc2231Value(starMatch[1]);

  const plainMatch =
    disposition.match(/filename\s*=\s*"?([^";\r\n]+)"?/i) ?? contentTypeRaw.match(/name\s*=\s*"?([^";\r\n]+)"?/i);
  if (plainMatch) return decodeRfc2047Value(plainMatch[1].trim());

  return "";
}

export type ExtractedAttachment =
  | { kind: "xlsx"; buffer: Buffer }
  | { kind: "csv"; text: string }
  | { kind: "pdf"; buffer: Buffer };

/** True when a part "looks like" an attachment (as opposed to an
 * inline body part) even though it isn't a recognized xlsx/csv — used
 * only to decide whether to log an "unsupported attachment type" line
 * below, never to change extraction behavior. */
function looksLikeAttachment(part: MimeLeaf, filename: string): boolean {
  const disposition = (getHeader(part.headers, "Content-Disposition") ?? "").toLowerCase();
  if (disposition.includes("attachment")) return true;
  if (filename) return true;
  if (part.contentType.includes("multipart")) return false;
  if (part.contentType.startsWith("text/plain") || part.contentType.startsWith("text/html")) return false;
  return true;
}

/**
 * Scans a raw MIME email for an xlsx/xls or csv/tsv ATTACHMENT part —
 * Pioneer's emailed on-hand report is most likely the same table its
 * manual export produces (V-ordering-targets, Will 2026-09-08), so the
 * SES webhook tries this before falling back to extractTextFromRawMime's
 * plain-text-part search. Recurses into nested multipart/* parts up to
 * MAX_MIME_DEPTH; the first recognizable xlsx/csv part (depth-first,
 * document order) wins. A recognized-but-unsupported attachment (e.g.
 * .pdf, .zip, .txt) is logged (type + filename only, never its body) and
 * skipped, so the NEXT unusual attachment tells us exactly what it is.
 * Returns null (never throws) for a non-multipart message or one with no
 * recognizable xlsx/csv part, so callers fall back to the plain-text
 * path.
 */
export function extractAttachmentFromRawMime(raw: string): ExtractedAttachment | null {
  const top = splitHeaderBody(raw);
  if (!top) return null;

  const topContentTypeRaw = getHeader(top.headers, "Content-Type") ?? "text/plain";
  if (!topContentTypeRaw.toLowerCase().includes("multipart")) return null;

  const parts: MimeLeaf[] = [];
  collectMimeParts(top.headers, top.body, 0, parts);

  for (const part of parts) {
    const filename = getAttachmentFilename(part.headers, part.contentTypeRaw);
    const encoding = getHeader(part.headers, "Content-Transfer-Encoding") ?? "";

    const isXlsx = XLSX_CONTENT_TYPE_PATTERN.test(part.contentTypeRaw) || XLSX_FILENAME_PATTERN.test(filename);
    const isCsv = !isXlsx && (CSV_CONTENT_TYPE_PATTERN.test(part.contentTypeRaw) || CSV_FILENAME_PATTERN.test(filename));
    const isPdf =
      !isXlsx && !isCsv && (PDF_CONTENT_TYPE_PATTERN.test(part.contentTypeRaw) || PDF_FILENAME_PATTERN.test(filename));

    if ((isXlsx || isCsv || isPdf) && part.body.length > MAX_ATTACHMENT_PART_CHARS) {
      // Oversized — skip WITHOUT decoding (never even reaches Buffer.from
      // or SheetJS's read()/pdfjs). Caller falls back to
      // extractTextFromRawMime's plain-text search; still a 200 response
      // either way.
      const label = isXlsx ? "xlsx" : isCsv ? "csv/tsv" : "pdf";
      console.warn(
        `extractAttachmentFromRawMime: skipping oversized ${label} attachment part ` +
          `(${part.body.length} raw chars > ${MAX_ATTACHMENT_PART_CHARS} max) — falling back to plain-text`
      );
      continue;
    }

    if (isXlsx) {
      try {
        return { kind: "xlsx", buffer: Buffer.from(part.body.replace(/\s/g, ""), "base64") };
      } catch {
        continue;
      }
    }

    if (isCsv) {
      const decoded = decodeByTransferEncoding(part.body, encoding).replace(/\r\n/g, "\n").trim();
      if (decoded) return { kind: "csv", text: decoded };
    }

    if (isPdf) {
      try {
        return { kind: "pdf", buffer: Buffer.from(part.body.replace(/\s/g, ""), "base64") };
      } catch {
        continue;
      }
    }

    if (!isXlsx && !isCsv && !isPdf && looksLikeAttachment(part, filename)) {
      const typeForLog = part.contentTypeRaw.split(";")[0].trim();
      console.warn(`extractAttachmentFromRawMime: unsupported attachment type=${typeForLog} name="${filename}"`);
    }
  }

  return null;
}

/** Strips tags/entities from an HTML fragment down to plain-ish text —
 * only ever used as a last-resort fallback (see extractTextFromRawMime)
 * when no text/plain part exists, never for anything logged. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
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

  const topContentTypeRaw = getHeader(top.headers, "Content-Type") ?? "text/plain";
  const topContentType = topContentTypeRaw.toLowerCase();

  if (!topContentType.includes("multipart")) {
    const encoding = getHeader(top.headers, "Content-Transfer-Encoding") ?? "";
    const decoded = decodeByTransferEncoding(top.body, encoding).replace(/\r\n/g, "\n").trim();
    return decoded || trimmedRaw;
  }

  const parts: MimeLeaf[] = [];
  collectMimeParts(top.headers, top.body, 0, parts);

  let htmlFallback: string | null = null;

  for (const part of parts) {
    const encoding = getHeader(part.headers, "Content-Transfer-Encoding") ?? "";

    if (part.contentType.includes("text/plain")) {
      const decoded = decodeByTransferEncoding(part.body, encoding).replace(/\r\n/g, "\n").trim();
      if (decoded) return decoded;
    } else if (htmlFallback === null && part.contentType.includes("text/html")) {
      const decodedHtml = decodeByTransferEncoding(part.body, encoding).replace(/\r\n/g, "\n").trim();
      const stripped = decodedHtml ? stripHtml(decodedHtml) : "";
      if (stripped) htmlFallback = stripped;
    }
    // Any other part content-type (image/*, application/*, ...) is
    // skipped here — attachments are never inspected for text.
  }

  // No text/plain part found anywhere in the tree — prefer a
  // stripped text/html part (e.g. an HTML-only multipart/alternative)
  // over the raw MIME text, since it's still readable content.
  if (htmlFallback) return htmlFallback;

  // Nothing usable found at all (e.g. depth-capped nesting, or no
  // text/plain or text/html part anywhere) — fall back to the raw text
  // for manual review rather than dropping the email.
  return trimmedRaw;
}
