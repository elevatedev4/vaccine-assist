import "server-only";
import { createHash } from "node:crypto";
import { isMissingTableError } from "@/lib/schema-degradation";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Idempotency for the SES webhook (V-onhand-dedupe, Will 2026-09-09
 * evening): SNS delivered the SAME Pioneer email twice in a real
 * incident (20:00:53 and 20:01:28) — with the batch-sum on-hand logic
 * (V-onhand-batch-sum, app/api/ordering/recommendation/route.ts), two
 * identical deliveries would now be SUMMED together instead of
 * harmlessly overwriting the same value.
 *
 * Two-tier dedupe, both backed by the generic `app_setting` table
 * (confirmed already applied in prod — same posture as
 * lib/ordering-settings.ts and lib/lots-settings.ts, degrading to "not
 * a duplicate" rather than erroring if it somehow isn't):
 *   1. PRIMARY — the SES message id (mail.messageId on a real
 *      "Received" notification, falling back to the SNS envelope's own
 *      MessageId): a 200-entry ring buffer under app_setting key
 *      "onhand.processed_message_ids". Exact-delivery dedupe — two SNS
 *      deliveries of the identical email carry the identical
 *      mail.messageId.
 *   2. FALLBACK — only when no message id is available at all (a
 *      malformed/unusual notification, or a future non-SNS caller that
 *      never had one): a sha256 of the parsed rows' `name|ndc|qty`,
 *      scoped to the resolved inbound address, treated as a duplicate
 *      when the identical hash was already recorded for that address
 *      within the last 10 minutes — app_setting key
 *      "onhand.last_batch_hash", one row shared across every address,
 *      shaped `{ [addressId]: { hash, at } }`.
 */

export const PROCESSED_MESSAGE_IDS_KEY = "onhand.processed_message_ids";
export const LAST_BATCH_HASH_KEY = "onhand.last_batch_hash";

const MAX_PROCESSED_IDS = 200;
const CONTENT_HASH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

type SupabaseClient = ReturnType<typeof getSupabaseServerClient>;

async function readAppSettingValue(supabase: SupabaseClient, key: string): Promise<{ value: unknown; missing: boolean }> {
  const { data, error } = await supabase.from("app_setting").select("value").eq("key", key).maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return { value: undefined, missing: true };
    throw error;
  }
  return { value: data?.value, missing: false };
}

async function writeAppSettingValue(supabase: SupabaseClient, key: string, value: unknown): Promise<void> {
  const { error } = await supabase
    .from("app_setting")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error && !isMissingTableError(error)) throw error;
}

/**
 * True when `messageId` is already in the ring buffer. Degrades to
 * false (never blocks ingestion — "proceed without dedupe") when
 * app_setting doesn't exist yet.
 */
export async function isMessageIdProcessed(supabase: SupabaseClient, messageId: string): Promise<boolean> {
  const { value } = await readAppSettingValue(supabase, PROCESSED_MESSAGE_IDS_KEY);
  return Array.isArray(value) && value.includes(messageId);
}

/**
 * Appends `messageId` to the ring buffer, trimmed to the last
 * MAX_PROCESSED_IDS entries (oldest dropped first) — de-duped against
 * itself too, so a retried mark-call for the same id never grows the
 * list. Called AFTER a successful insert, never before (see this file's
 * header comment). No-ops (doesn't throw) when app_setting is missing —
 * callers should still log if they want visibility into that.
 */
export async function markMessageIdProcessed(supabase: SupabaseClient, messageId: string): Promise<void> {
  const { value, missing } = await readAppSettingValue(supabase, PROCESSED_MESSAGE_IDS_KEY);
  if (missing) return;

  const existing = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const next = [...existing.filter((id) => id !== messageId), messageId].slice(-MAX_PROCESSED_IDS);
  await writeAppSettingValue(supabase, PROCESSED_MESSAGE_IDS_KEY, next);
}

export type HashableOnHandRow = { vaccineNameRaw: string; ndc: string | null; quantity: number | null };

/** sha256 of the normalized "name|ndc|qty" rows, newline-joined — used
 * ONLY as the fallback when no SES message id is available at all. */
export function computeBatchContentHash(rows: readonly HashableOnHandRow[]): string {
  const normalized = rows
    .map((row) => `${row.vaccineNameRaw.trim().toLowerCase()}|${row.ndc ?? ""}|${row.quantity ?? ""}`)
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

type LastBatchHashEntry = { hash: string; at: string };
type LastBatchHashMap = Record<string, LastBatchHashEntry>;

/**
 * True when this exact content hash was already recorded for
 * `addressId` within the last 10 minutes. Degrades to false when
 * app_setting doesn't exist yet.
 */
export async function isDuplicateContentHash(
  supabase: SupabaseClient,
  addressId: string,
  hash: string,
  now: Date
): Promise<boolean> {
  const { value } = await readAppSettingValue(supabase, LAST_BATCH_HASH_KEY);
  const map = (value ?? {}) as LastBatchHashMap;
  const entry = map[addressId];
  if (!entry || entry.hash !== hash) return false;
  const ageMs = now.getTime() - new Date(entry.at).getTime();
  return ageMs >= 0 && ageMs <= CONTENT_HASH_WINDOW_MS;
}

/** Records `{hash, at: now}` for `addressId`, merging into whatever the
 * other addresses' entries already are. No-ops when app_setting is
 * missing. */
export async function recordContentHash(supabase: SupabaseClient, addressId: string, hash: string, now: Date): Promise<void> {
  const { value, missing } = await readAppSettingValue(supabase, LAST_BATCH_HASH_KEY);
  if (missing) return;

  const map = (value ?? {}) as LastBatchHashMap;
  const next: LastBatchHashMap = { ...map, [addressId]: { hash, at: now.toISOString() } };
  await writeAppSettingValue(supabase, LAST_BATCH_HASH_KEY, next);
}
