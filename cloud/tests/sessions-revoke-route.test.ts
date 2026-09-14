import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { DELETE } from "@/app/api/sessions/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function deleteRequest(id: string) {
  return new Request(`http://localhost/api/sessions/${id}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer test-token" },
  });
}

function fakeSupabaseRpc(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) };
}

describe("DELETE /api/sessions/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("revokes a session owned by the caller", async () => {
    const supabase = fakeSupabaseRpc(true);
    vi.mocked(getSupabaseServerClient).mockReturnValue(supabase as never);

    const response = await DELETE(deleteRequest("sess-1"), { params: Promise.resolve({ id: "sess-1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith("revoke_my_session", { uid: "user-1", target_id: "sess-1" });
  });

  it("returns 404 when nothing was deleted (not found / not owned by the caller)", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseRpc(false) as never);

    const response = await DELETE(deleteRequest("sess-2"), { params: Promise.resolve({ id: "sess-2" }) });
    expect(response.status).toBe(404);
  });

  it("returns 409 with pending:true when the migration hasn't run yet", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseRpc(null, { code: "PGRST202", message: "Could not find the function public.revoke_my_session" }) as never
    );

    const response = await DELETE(deleteRequest("sess-1"), { params: Promise.resolve({ id: "sess-1" }) });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.pending).toBe(true);
  });

  it("returns 500 for an unrelated Supabase error", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseRpc(null, { code: "XX000", message: "internal error" }) as never
    );

    const response = await DELETE(deleteRequest("sess-1"), { params: Promise.resolve({ id: "sess-1" }) });
    expect(response.status).toBe(500);
  });

  it("returns 400 when the id param is empty", async () => {
    const response = await DELETE(deleteRequest(""), { params: Promise.resolve({ id: "" }) });
    expect(response.status).toBe(400);
  });

  it("returns 503 when Supabase isn't configured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    const response = await DELETE(deleteRequest("sess-1"), { params: Promise.resolve({ id: "sess-1" }) });
    expect(response.status).toBe(503);
  });
});
