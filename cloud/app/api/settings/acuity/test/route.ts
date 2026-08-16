import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth";
import { getAcuityCredentials } from "@/lib/acuity-credentials";
import { testAcuityConnection } from "@/lib/acuity-client";

/**
 * "Test connection" button on the /settings UI. If the request body has
 * both fields, tests those directly (lets a user verify a new key before
 * saving it). Otherwise tests whatever is currently active — stored
 * credentials, falling back to env vars — so an already-configured
 * connection can be re-verified without retyping anything.
 */
export async function POST(request: Request) {
  const auth = await requireAuthenticatedUser(request);
  if ("error" in auth) return auth.error;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { acuityUserId, acuityApiKey } = (body ?? {}) as {
    acuityUserId?: unknown;
    acuityApiKey?: unknown;
  };

  const userId = typeof acuityUserId === "string" ? acuityUserId.trim() : "";
  const apiKey = typeof acuityApiKey === "string" ? acuityApiKey.trim() : "";

  if (userId && apiKey) {
    const result = await testAcuityConnection(userId, apiKey);
    return NextResponse.json(result);
  }

  const stored = await getAcuityCredentials();
  if (!stored) {
    return NextResponse.json({ ok: false, message: "No Acuity credentials configured yet." });
  }

  const result = await testAcuityConnection(stored.userId, stored.apiKey);
  return NextResponse.json(result);
}
