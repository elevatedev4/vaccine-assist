import "server-only";
import { read, utils } from "xlsx";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Inbound-email attachment RETENTION (V-inbound-attachment-retention,
 * 2026-09-11) — Pioneer sent a NEW report shape (a per-dose vaccination
 * log, first header cell "Completed date") that the BOH parser correctly
 * matched 0 rows out of, and because nothing raw was ever persisted the
 * file was simply gone. This file backs the fix: every attachment the
 * SES webhook (app/api/webhooks/ses/route.ts) extracts gets written to
 * the existing generic `app_setting` key/value table (same table/helper
 * pattern as lib/ordering-settings.ts's walk-up % and
 * lib/lots-settings.ts's BUD-enabled products — supabase/migrations/
 * 0012_app_setting.sql, confirmed already applied in prod) BEFORE any
 * BOH parsing is attempted, so a parser crash or a 0-match report never
 * loses the underlying file. Admin read access is
 * app/api/inbound/attachments/route.ts (list, no base64) and
 * app/api/inbound/attachments/[key]/route.ts (download one), both gated
 * by the same requireAuthenticatedUser guard as every other admin route
 * in this app (see e.g. app/api/vaccines/route.ts) — no separate
 * `?secret=` mechanism exists for this app's non-webhook admin routes,
 * so none is added here.
 *
 * PHI caution: an attachment can contain patient names (this is exactly
 * why the vaccination-log report is worth keeping — Will's brief). It is
 * stored server-side only, behind auth, and NEVER logged — only the
 * filename/byte count/outcome are logged (see the webhook route), never
 * the base64 payload or decoded rows.
 */

export const INBOUND_ATTACHMENT_KEY_PREFIX = "inbound_attachment:";

/** Base64-character cap for a retained attachment (Will's brief: skip
 * persisting anything bigger and just log it — retention is a
 * best-effort safety net, not a place to blow up app_setting with a
 * multi-megabyte row). */
export const MAX_RETAINED_BASE64_CHARS = 1_500_000;

/** Keep at most this many `inbound_attachment:*` rows — oldest evicted
 * first (see selectKeysToEvict) on every successful persist. */
export const MAX_RETAINED_ATTACHMENTS = 30;

export type RetainedAttachment = {
  receivedAt: string;
  from: string;
  subject: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  base64: string;
};

export type RetainedAttachmentMeta = Omit<RetainedAttachment, "base64"> & { key: string };

/**
 * Sanitizes a filename for embedding as one segment of an app_setting
 * key: keeps [A-Za-z0-9._-], replaces every other character (spaces,
 * path separators, colons, unicode, ...) with "_", collapses repeats,
 * trims leading/trailing "_", and caps length — bounds a pathological
 * attachment filename from producing a huge or path-traversal-shaped
 * key. Never returns "" (falls back to "attachment").
 */
export function sanitizeFilenameForKey(filename: string): string {
  const cleaned = filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 120) || "attachment";
}

/** `inbound_attachment:<ISO receivedAt>:<sanitized filename>` — the ISO
 * timestamp segment is what makes plain lexical key sort == chronological
 * sort (selectKeysToEvict below relies on this). */
export function buildAttachmentKey(receivedAt: string, filename: string): string {
  return `${INBOUND_ATTACHMENT_KEY_PREFIX}${receivedAt}:${sanitizeFilenameForKey(filename)}`;
}

/**
 * Given every existing `inbound_attachment:*` key (any order — a
 * just-inserted key included), returns the keys to DELETE so at most
 * `cap` newest remain. "Newest" is the ISO-timestamp segment embedded in
 * the key, which sorts lexically the same as chronologically, so a plain
 * string sort is enough — no need to parse dates back out.
 */
export function selectKeysToEvict(keys: readonly string[], cap: number): string[] {
  if (keys.length <= cap) return [];
  const sorted = [...keys].sort();
  return sorted.slice(0, sorted.length - cap);
}

export type PersistResult = { persisted: true } | { persisted: false; reason: "oversized" | "missing-table" };

/**
 * Persists one retained attachment, then sweeps `inbound_attachment:*`
 * down to MAX_RETAINED_ATTACHMENTS newest (deleting the oldest excess).
 * Skips (never throws) for an oversized base64 payload or a database
 * that hasn't run 0012 yet (isMissingTableError) — both are logged by
 * the caller via the returned reason. Any OTHER Supabase error is
 * re-thrown so the caller's try/catch (the webhook route: "persistence
 * failure must be caught + logged and must NOT change the webhook's
 * response") is the single place that decides how to swallow it.
 * The eviction sweep itself is best-effort: a failure there is caught
 * and logged here (never thrown) since the attachment being persisted
 * is what matters, not immediately hitting the exact cap.
 */
export async function persistInboundAttachment(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  attachment: RetainedAttachment
): Promise<PersistResult> {
  if (attachment.base64.length > MAX_RETAINED_BASE64_CHARS) {
    console.warn(
      `persistInboundAttachment: skipping oversized attachment "${attachment.filename}" ` +
        `(${attachment.base64.length} base64 chars > ${MAX_RETAINED_BASE64_CHARS} max)`
    );
    return { persisted: false, reason: "oversized" };
  }

  const key = buildAttachmentKey(attachment.receivedAt, attachment.filename);
  const { error: upsertError } = await supabase.from("app_setting").upsert({ key, value: attachment });
  if (upsertError) {
    if (isMissingTableError(upsertError)) {
      console.warn("persistInboundAttachment: app_setting table missing — skipping retention (0012 not applied yet)");
      return { persisted: false, reason: "missing-table" };
    }
    throw upsertError;
  }

  try {
    const { data, error: listError } = await supabase
      .from("app_setting")
      .select("key")
      .like("key", `${INBOUND_ATTACHMENT_KEY_PREFIX}%`);
    if (listError) throw listError;
    const allKeys = ((data ?? []) as { key: string }[]).map((row) => row.key);
    const toEvict = selectKeysToEvict(allKeys, MAX_RETAINED_ATTACHMENTS);
    for (const evictKey of toEvict) {
      const { error: deleteError } = await supabase.from("app_setting").delete().eq("key", evictKey);
      if (deleteError) {
        console.warn(`persistInboundAttachment: failed to evict old attachment key=${evictKey}`, deleteError);
      }
    }
  } catch (err) {
    console.warn("persistInboundAttachment: eviction sweep failed (attachment was still persisted)", err);
  }

  return { persisted: true };
}

/** List metadata for every retained attachment (newest first), base64
 * OMITTED — used by GET /api/inbound/attachments. Throws on a genuine
 * Supabase error; returns [] (not an error) when app_setting doesn't
 * exist yet, same degrade posture as lib/ordering-settings.ts. */
export async function listInboundAttachments(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<RetainedAttachmentMeta[]> {
  const { data, error } = await supabase
    .from("app_setting")
    .select("key, value")
    .like("key", `${INBOUND_ATTACHMENT_KEY_PREFIX}%`);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  const rows = (data ?? []) as { key: string; value: RetainedAttachment }[];
  return rows
    .map(({ key, value }) => {
      const { base64: _base64, ...meta } = value;
      return { key, ...meta };
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)); // newest first
}

/** Fetch one retained attachment's full row (base64 included) by exact
 * key — used by GET /api/inbound/attachments/[key]. Returns null for an
 * unknown key or a not-yet-migrated database (never throws for either);
 * throws on any other Supabase error. */
export async function getInboundAttachmentByKey(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  key: string
): Promise<RetainedAttachment | null> {
  const { data, error } = await supabase.from("app_setting").select("value").eq("key", key).maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }

  return (data?.value as RetainedAttachment | undefined) ?? null;
}

// --- Header-row extraction + vaccination-log detection (V-inbound-
// attachment-retention item 2) ---------------------------------------

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function firstNonEmptyRow(matrix: unknown[][]): unknown[] | null {
  for (const row of matrix) {
    if (row && row.some((cell) => cellToString(cell) !== "")) return row;
  }
  return null;
}

export type AttachmentHeaderInfo = { headerLine: string; rowCount: number };

/** The first non-empty row's cells (joined " | ") plus the matrix's
 * total row count — logged at info level so the NEXT unusual report
 * tells us its columns straight from Vercel logs, per Will's brief.
 * Returns null for an empty matrix. */
export function headerInfoFromMatrix(matrix: unknown[][]): AttachmentHeaderInfo | null {
  const header = firstNonEmptyRow(matrix);
  if (!header) return null;
  return { headerLine: header.map(cellToString).join(" | "), rowCount: matrix.length };
}

/** Same 2D-array shape lib/on-hand/pioneer-boh.ts's parsePioneerBohXlsx
 * uses (SheetJS sheet_to_json({header:1})) — kept separate here so
 * header inspection never depends on the BOH-specific row parser. */
export function matrixFromXlsxBuffer(buffer: Buffer): unknown[][] {
  const workbook = read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  return utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
}

/** Minimal delimited-text splitter for header inspection only (no quote
 * handling needed — this is used for logging, not for feeding numbers
 * into on_hand_count). */
export function matrixFromDelimitedText(text: string, delimiter: "," | "\t"): unknown[][] {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(delimiter));
}

/** True when a header row looks like PioneerRx's per-dose vaccination
 * log (as opposed to the BOH stock report) — case-insensitive "Completed
 * date" anywhere in the header cells, per the real report Will forwarded
 * 2026-09-11 20:39Z. */
export function isVaccinationLogHeaderLine(headerLine: string): boolean {
  return headerLine.toLowerCase().includes("completed date");
}
