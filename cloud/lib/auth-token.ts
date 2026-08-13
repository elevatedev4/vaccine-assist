/**
 * Pure header parsing, split out from lib/auth.ts so it can be unit
 * tested with plain vitest/node — lib/auth.ts imports "server-only",
 * which throws unconditionally outside Next's server/client build
 * boundary (i.e. under plain vitest).
 */
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
