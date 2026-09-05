import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/physicians/resolve/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } });
}

describe("GET /api/physicians/resolve", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("rejects a missing vaccineId", async () => {
    const response = await GET(authedRequest("/api/physicians/resolve?ageYears=10"));
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a missing/non-numeric ageYears", async () => {
    const response = await GET(authedRequest("/api/physicians/resolve?vaccineId=v1"));
    expect(response.status).toBe(400);

    const responseNaN = await GET(authedRequest("/api/physicians/resolve?vaccineId=v1&ageYears=abc"));
    expect(responseNaN.status).toBe(400);
  });

  it("resolves the matching physician, querying rules for this vaccine or a wildcard", async () => {
    const rulesOr = vi.fn(async (filter: string) => {
      expect(filter).toBe("vaccine_id.eq.v1,vaccine_id.is.null");
      return {
        data: [{ id: "r1", physician_id: "p1", vaccine_id: "v1", min_age: 3, max_age: null, priority: 0 }],
        error: null,
      };
    });
    const from = vi.fn((table: string) => {
      if (table === "physician_rule") return { select: () => ({ or: rulesOr }) };
      if (table === "physician") {
        return {
          select: async () => ({
            data: [{ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" }],
            error: null,
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physicians/resolve?vaccineId=v1&ageYears=10"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALTPRIMARY" });
  });

  it("returns physician: null when nothing matches", async () => {
    const from = vi.fn((table: string) => {
      if (table === "physician_rule") return { select: () => ({ or: async () => ({ data: [], error: null }) }) };
      if (table === "physician") return { select: async () => ({ data: [], error: null }) };
      throw new Error(`unexpected table ${table}`);
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physicians/resolve?vaccineId=v1&ageYears=10"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physician).toBeNull();
  });

  it("returns 500 when either Supabase call errors", async () => {
    const from = vi.fn((table: string) => {
      if (table === "physician_rule") return { select: () => ({ or: async () => ({ data: null, error: new Error("boom") }) }) };
      return { select: async () => ({ data: [], error: null }) };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physicians/resolve?vaccineId=v1&ageYears=10"));
    expect(response.status).toBe(500);
  });
});
