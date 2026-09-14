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

import { POST } from "@/app/api/sessions/sign-out-everywhere/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest() {
  return new Request("http://localhost/api/sessions/sign-out-everywhere", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

function fakeSupabaseAdmin(error: unknown = null) {
  return { auth: { admin: { signOut: vi.fn(async () => ({ error })) } } };
}

describe("POST /api/sessions/sign-out-everywhere", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("calls admin.signOut with the caller's token and scope 'global'", async () => {
    const supabase = fakeSupabaseAdmin();
    vi.mocked(getSupabaseServerClient).mockReturnValue(supabase as never);

    const response = await POST(authedRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(supabase.auth.admin.signOut).toHaveBeenCalledWith("test-token", "global");
  });

  it("returns 500 when admin.signOut errors", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseAdmin({ message: "boom" }) as never);

    const response = await POST(authedRequest());
    expect(response.status).toBe(500);
  });

  it("returns 503 when Supabase isn't configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    const response = await POST(authedRequest());
    expect(response.status).toBe(503);
  });
});
