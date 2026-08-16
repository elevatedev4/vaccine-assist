import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

/**
 * Resolves the Acuity credentials the server-side fetch path should use
 * (see app/api/acuity/poll/route.ts) — the `acuity_credentials` table
 * (set via the /settings UI, app/api/settings/acuity/route.ts) first,
 * falling back to ACUITY_USER_ID/ACUITY_API_KEY env vars if that row
 * doesn't exist yet. The API key is never logged.
 */

export type AcuityCredentials = {
  userId: string;
  apiKey: string;
  source: "database" | "env";
};

export type AcuityCredentialsStatus = {
  configured: boolean;
  source: "database" | "env" | "none";
  acuityUserId: string | null;
  last4: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

async function readStoredRow(): Promise<{
  acuity_user_id: string;
  acuity_api_key: string;
  updated_at: string;
  updated_by: string | null;
} | null> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("acuity_credentials")
    .select("acuity_user_id, acuity_api_key, updated_at, updated_by")
    .eq("id", 1)
    .maybeSingle();

  if (error || !data || !data.acuity_user_id || !data.acuity_api_key) return null;
  return data;
}

export async function getAcuityCredentials(): Promise<AcuityCredentials | null> {
  try {
    const row = await readStoredRow();
    if (row) {
      return { userId: row.acuity_user_id, apiKey: row.acuity_api_key, source: "database" };
    }
  } catch {
    // Supabase not configured yet (phase 1), or the migration hasn't
    // been applied — fall through to env vars either way.
  }

  const envUserId = env.acuityUserId();
  const envApiKey = env.acuityApiKey();
  if (envUserId && envApiKey) {
    return { userId: envUserId, apiKey: envApiKey, source: "env" };
  }

  return null;
}

export async function getAcuityCredentialsStatus(): Promise<AcuityCredentialsStatus> {
  try {
    const row = await readStoredRow();
    if (row) {
      return {
        configured: true,
        source: "database",
        acuityUserId: row.acuity_user_id,
        last4: row.acuity_api_key.slice(-4),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    }
  } catch {
    // See getAcuityCredentials — fall through to env vars.
  }

  const envUserId = env.acuityUserId();
  const envApiKey = env.acuityApiKey();
  if (envUserId && envApiKey) {
    return {
      configured: true,
      source: "env",
      acuityUserId: envUserId,
      last4: envApiKey.slice(-4),
      updatedAt: null,
      updatedBy: null,
    };
  }

  return { configured: false, source: "none", acuityUserId: null, last4: null, updatedAt: null, updatedBy: null };
}
