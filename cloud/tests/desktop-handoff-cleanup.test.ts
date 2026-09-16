import { describe, expect, it, vi } from "vitest";
import { getRequestIp, revokeOlderDesktopSessionsForSameDevice } from "@/lib/desktop-handoff";

/**
 * Unit tests for the duplicate-session cleanup added to
 * app/api/auth/desktop-handoff/route.ts (Will, 2026-09-16: "is there a
 * way to not show duplicate sessions if it's the same computer?"). Mocks
 * a minimal Supabase client (just the `.rpc` calls this function makes)
 * rather than a real project — same posture as
 * tests/sessions-revoke-route.test.ts.
 */

function fakeSupabase(listResult: { data: unknown; error: unknown }) {
  const revokeCalls: Array<{ uid: string; target_id: string }> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "list_my_sessions") return listResult;
    if (fn === "revoke_my_session") {
      revokeCalls.push(args as { uid: string; target_id: string });
      return { data: true, error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  });
  return { rpc, revokeCalls } as unknown as { rpc: typeof rpc; revokeCalls: typeof revokeCalls };
}

/** A real (unsigned-signature) JWT with a session_id claim. */
function tokenWithSessionId(sessionId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user-1", session_id: sessionId })).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

describe("getRequestIp", () => {
  it("reads the first address from x-forwarded-for", () => {
    const request = new Request("http://localhost/x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
    expect(getRequestIp(request)).toBe("9.9.9.9");
  });

  it("returns null when the header is absent", () => {
    const request = new Request("http://localhost/x");
    expect(getRequestIp(request)).toBeNull();
  });
});

describe("revokeOlderDesktopSessionsForSameDevice", () => {
  it("revokes other desktop sessions for the same user sharing the request IP", async () => {
    const rows = [
      { id: "new-session", user_agent: null, ip: "9.9.9.9" },
      { id: "old-launch-1", user_agent: null, ip: "9.9.9.9" },
      { id: "old-launch-2", user_agent: null, ip: "9.9.9.9" },
    ];
    const supabase = fakeSupabase({ data: rows, error: null });

    await revokeOlderDesktopSessionsForSameDevice({
      supabase: supabase as never,
      userId: "user-1",
      newSessionAccessToken: tokenWithSessionId("new-session"),
      requestIp: "9.9.9.9",
    });

    expect(supabase.revokeCalls.map((c) => c.target_id).sort()).toEqual(["old-launch-1", "old-launch-2"]);
    expect(supabase.revokeCalls.every((c) => c.uid === "user-1")).toBe(true);
  });

  it("never revokes the just-created session itself", async () => {
    const rows = [{ id: "new-session", user_agent: null, ip: "9.9.9.9" }];
    const supabase = fakeSupabase({ data: rows, error: null });

    await revokeOlderDesktopSessionsForSameDevice({
      supabase: supabase as never,
      userId: "user-1",
      newSessionAccessToken: tokenWithSessionId("new-session"),
      requestIp: "9.9.9.9",
    });

    expect(supabase.revokeCalls).toHaveLength(0);
  });

  it("does not revoke sessions from a different IP", async () => {
    const rows = [
      { id: "new-session", user_agent: null, ip: "9.9.9.9" },
      { id: "other-workstation", user_agent: null, ip: "8.8.8.8" },
    ];
    const supabase = fakeSupabase({ data: rows, error: null });

    await revokeOlderDesktopSessionsForSameDevice({
      supabase: supabase as never,
      userId: "user-1",
      newSessionAccessToken: tokenWithSessionId("new-session"),
      requestIp: "9.9.9.9",
    });

    expect(supabase.revokeCalls).toHaveLength(0);
  });

  it("does not revoke a browser session even if it somehow shares the IP", async () => {
    const rows = [
      { id: "new-session", user_agent: null, ip: "9.9.9.9" },
      {
        id: "browser-session",
        user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36",
        ip: "9.9.9.9",
      },
    ];
    const supabase = fakeSupabase({ data: rows, error: null });

    await revokeOlderDesktopSessionsForSameDevice({
      supabase: supabase as never,
      userId: "user-1",
      newSessionAccessToken: tokenWithSessionId("new-session"),
      requestIp: "9.9.9.9",
    });

    expect(supabase.revokeCalls).toHaveLength(0);
  });

  it("does nothing when requestIp is null (can't safely identify the device)", async () => {
    const supabase = fakeSupabase({ data: [], error: null });

    await revokeOlderDesktopSessionsForSameDevice({
      supabase: supabase as never,
      userId: "user-1",
      newSessionAccessToken: tokenWithSessionId("new-session"),
      requestIp: null,
    });

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("is a no-op (never throws) when the 0013 migration hasn't been applied yet", async () => {
    const supabase = fakeSupabase({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });

    await expect(
      revokeOlderDesktopSessionsForSameDevice({
        supabase: supabase as never,
        userId: "user-1",
        newSessionAccessToken: tokenWithSessionId("new-session"),
        requestIp: "9.9.9.9",
      })
    ).resolves.toBeUndefined();
  });

  it("never throws even if the RPC call itself throws", async () => {
    const supabase = { rpc: vi.fn(() => { throw new Error("boom"); }) };

    await expect(
      revokeOlderDesktopSessionsForSameDevice({
        supabase: supabase as never,
        userId: "user-1",
        newSessionAccessToken: tokenWithSessionId("new-session"),
        requestIp: "9.9.9.9",
      })
    ).resolves.toBeUndefined();
  });
});
