import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/on-hand/address", () => ({
  getOrCreateAddressForUser: vi.fn(),
  buildAddress: (token: string) => `vaccines-${token}@in.orchardsdrug.com`,
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/on-hand/address/route";
import { getOrCreateAddressForUser } from "@/lib/on-hand/address";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ADDRESS = {
  id: "addr-1",
  userId: "user-1",
  token: "0123456789abcdef0123456789abcdef",
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastReceivedAt: null as string | null,
};

function authedRequest() {
  return new Request("http://localhost/api/on-hand/address", { headers: { Authorization: "Bearer test-token" } });
}

function fakeSupabase(count: number, error: unknown = null) {
  return {
    from: () => ({
      select: () => ({
        or: async () => ({ count, error }),
      }),
    }),
  };
}

describe("GET /api/on-hand/address", () => {
  afterEach(() => {
    vi.mocked(getOrCreateAddressForUser).mockReset();
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("creates/returns the address, with hasData=false when no rows exist", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(0) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      address: "vaccines-0123456789abcdef0123456789abcdef@in.orchardsdrug.com",
      token: ADDRESS.token,
      lastReceivedAt: null,
      hasData: false,
    });
  });

  it("returns hasData=true once at least one row exists for this account or a legacy null-address row", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue({ ...ADDRESS, lastReceivedAt: "2026-09-05T00:00:00.000Z" });
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(3) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.hasData).toBe(true);
    expect(body.lastReceivedAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("returns { pending: true } instead of an error when the migration hasn't been applied yet", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue({
      code: "42P01",
      message: 'relation "inbound_email_address" does not exist',
    });

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pending: true });
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns 503 for an unrelated address-resolution failure", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue(new Error("Supabase server client requested but not configured."));

    const response = await GET(authedRequest());
    expect(response.status).toBe(503);
  });
});
