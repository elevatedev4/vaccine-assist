import "server-only";
import { randomBytes } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Per-account inbound on-hand email address (V-onhand-account-address,
 * Will 2026-09-08) — backs supabase/migrations/0010_inbound_email_address.sql.
 * One place that knows the address SHAPE and how to resolve/create it, so
 * the SES webhook (app/api/webhooks/ses/route.ts) and the settings-facing
 * API (app/api/on-hand/address/route.ts, app/api/on-hand/upload/route.ts)
 * can't drift out of sync — mirrors ~/claude/pharmacy-kpis's
 * lib/emailIn/address.ts, adapted to this app's Supabase (not Prisma)
 * server client and its "vaccines-" local-part prefix.
 *
 * Account = Supabase auth user id. This app is still one shared pharmacy
 * login today, but every user created later gets its own row/address
 * here with zero further migration.
 */

export const ON_HAND_EMAIL_DOMAIN = "in.orchardsdrug.com";
export const ON_HAND_EMAIL_LOCAL_PREFIX = "vaccines-";

// 16 bytes = 128 bits of entropy, 32 hex chars. Unguessability is the
// WHOLE security model here (there's no other check on who's allowed to
// send data to a given address) — never derive this from anything
// guessable (user id, email, time).
const TOKEN_BYTES = 16;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function buildAddress(token: string): string {
  return `${ON_HAND_EMAIL_LOCAL_PREFIX}${token}@${ON_HAND_EMAIL_DOMAIN}`;
}

/**
 * Parses an arbitrary recipient address string into the raw token, or
 * null if it doesn't match our scheme at all. Deliberately strict: a
 * token that doesn't look like our own lowercase-hex format is treated
 * exactly like "no match" (never half-parsed) — this is what makes the
 * legacy fixed `vaccines-onhand@in.orchardsdrug.com` address resolve to
 * null ("onhand" isn't 32+ hex chars) rather than accidentally matching
 * anything.
 */
export function parseToken(address: string): string | null {
  if (!address) return null;
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return null;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== ON_HAND_EMAIL_DOMAIN) return null;
  if (!local.startsWith(ON_HAND_EMAIL_LOCAL_PREFIX)) return null;

  const token = local.slice(ON_HAND_EMAIL_LOCAL_PREFIX.length);
  if (!/^[0-9a-f]+$/.test(token) || token.length < TOKEN_HEX_LENGTH) return null;
  return token;
}

export type InboundEmailAddress = {
  id: string;
  userId: string;
  token: string;
  enabled: boolean;
  createdAt: string;
  lastReceivedAt: string | null;
};

type InboundEmailAddressRow = {
  id: string;
  user_id: string;
  token: string;
  enabled: boolean;
  created_at: string;
  last_received_at: string | null;
};

const ADDRESS_COLUMNS = "id, user_id, token, enabled, created_at, last_received_at";

function toAddress(row: InboundEmailAddressRow): InboundEmailAddress {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    enabled: row.enabled,
    createdAt: row.created_at,
    lastReceivedAt: row.last_received_at,
  };
}

/**
 * Returns the given user's inbound address, creating one on first call.
 * Throws (rather than swallowing) when the underlying query fails —
 * callers that need to degrade gracefully before
 * supabase/migrations/0010_inbound_email_address.sql has been applied
 * check the thrown error with lib/schema-degradation.ts's
 * isMissingTableError.
 */
export async function getOrCreateAddressForUser(userId: string): Promise<InboundEmailAddress> {
  const supabase = getSupabaseServerClient();

  const { data: existing, error: selectError } = await supabase
    .from("inbound_email_address")
    .select(ADDRESS_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing) return toAddress(existing as InboundEmailAddressRow);

  const { data: inserted, error: insertError } = await supabase
    .from("inbound_email_address")
    .insert({ user_id: userId, token: generateToken() })
    .select(ADDRESS_COLUMNS)
    .single();

  if (insertError) {
    // Unique-constraint race (23505 on user_id or, astronomically
    // unlikely, token): another request created this user's row between
    // our select and insert above — re-select rather than surfacing a
    // spurious failure to a legitimate caller.
    if (insertError.code === "23505") {
      const { data: reselected, error: reselectError } = await supabase
        .from("inbound_email_address")
        .select(ADDRESS_COLUMNS)
        .eq("user_id", userId)
        .maybeSingle();
      if (reselectError || !reselected) throw reselectError ?? insertError;
      return toAddress(reselected as InboundEmailAddressRow);
    }
    throw insertError;
  }

  return toAddress(inserted as InboundEmailAddressRow);
}

/**
 * Looks up an address by its raw token (already extracted via
 * parseToken). Never throws on a "not found" or query-error outcome —
 * both are indistinguishable from the webhook's point of view (see
 * app/api/webhooks/ses/route.ts's unknown-recipient handling), so this
 * returns null for either rather than making every caller re-check
 * `error`.
 */
export async function findAddressByToken(token: string): Promise<InboundEmailAddress | null> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("inbound_email_address")
    .select(ADDRESS_COLUMNS)
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return null;
  return toAddress(data as InboundEmailAddressRow);
}

/** Best-effort — a failure to record "last received" must never fail the
 * ingest itself (the data is already inserted by the time this runs). */
export async function touchLastReceived(addressId: string): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase
      .from("inbound_email_address")
      .update({ last_received_at: new Date().toISOString() })
      .eq("id", addressId);
  } catch (err) {
    console.error("touchLastReceived: failed to update last_received_at", err);
  }
}
