import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
  extractBearerToken: (header: string | null) => {
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    return match ? match[1] : null;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/sessions/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/** A real (unsigned-signature) JWT with a session_id claim, for getSessionIdFromToken to decode. */
function tokenWithSessionId(sessionId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user-1", session_id: sessionId })).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

function authedRequest(token: string) {
  return new Request("http://localhost/api/sessions", { headers: { Authorization: `Bearer ${token}` } });
}

function fakeSupabaseRpc(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) };
}

describe("GET /api/sessions", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("lists sessions with a friendly device label and isCurrent matched by session_id claim", async () => {
    const rows = [
      {
        id: "sess-current",
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-10T00:00:00.000Z",
        refreshed_at: "2026-09-12T00:00:00.000Z",
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      },
      {
        id: "sess-desktop",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-20T00:00:00.000Z",
        refreshed_at: null,
        user_agent: null,
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseRpc(rows) as never);

    const response = await GET(authedRequest(tokenWithSessionId("sess-current")));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      sessions: [
        {
          id: "sess-current",
          device: "Chrome on Windows",
          createdAt: "2026-09-01T00:00:00.000Z",
          lastActiveAt: "2026-09-12T00:00:00.000Z",
          isCurrent: true,
        },
        {
          id: "sess-desktop",
          device: "Windows desktop app",
          createdAt: "2026-08-01T00:00:00.000Z",
          lastActiveAt: "2026-08-20T00:00:00.000Z",
          isCurrent: false,
        },
      ],
    });
  });

  it("falls back lastActiveAt to updated_at when refreshed_at is null", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseRpc([
        {
          id: "sess-1",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-05T00:00:00.000Z",
          refreshed_at: null,
          user_agent: null,
        },
      ]) as never
    );

    const response = await GET(authedRequest(tokenWithSessionId("other-session")));
    const body = await response.json();
    expect(body.sessions[0].lastActiveAt).toBe("2026-08-05T00:00:00.000Z");
  });

  it("returns { pending: true } when the RPC function hasn't been migrated yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseRpc(null, { code: "PGRST202", message: "Could not find the function public.list_my_sessions" }) as never
    );

    const response = await GET(authedRequest(tokenWithSessionId("sess-1")));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pending: true });
  });

  it("returns 500 for an unrelated Supabase error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseRpc(null, { code: "XX000", message: "internal error" }) as never
    );

    const response = await GET(authedRequest(tokenWithSessionId("sess-1")));
    expect(response.status).toBe(500);
  });

  it("returns 503 when Supabase isn't configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    const response = await GET(authedRequest(tokenWithSessionId("sess-1")));
    expect(response.status).toBe(503);
  });
});
