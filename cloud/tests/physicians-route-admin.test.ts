import { afterEach, describe, expect, it, vi } from "vitest";

// Same pattern as tests/vaccines-route-admin.test.ts: mock auth to always
// succeed so each route's OWN logic (validation, the actual Supabase
// call) can be exercised directly. The real 401-with-no-header auth gate
// is covered separately in tests/physicians-route.test.ts.
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, POST } from "@/app/api/physicians/route";
import { PATCH, DELETE } from "@/app/api/physicians/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer test-token", ...(init?.headers ?? {}) },
  });
}

describe("GET /api/physicians", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("lists physicians ordered by display_name", async () => {
    const order = vi.fn(async () => ({
      data: [{ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALT1" }],
      error: null,
    }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn((table: string) => {
      if (table !== "physician") throw new Error(`unexpected table ${table}`);
      return { select };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physicians"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physicians).toEqual([{ id: "p1", display_name: "Rivera, Ana", alternate_id: "ALT1" }]);
    expect(order).toHaveBeenCalledWith("display_name", { ascending: true });
  });

  it("returns 500 on a Supabase error", async () => {
    const from = vi.fn(() => ({ select: () => ({ order: async () => ({ data: null, error: new Error("boom") }) }) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physicians"));
    expect(response.status).toBe(500);
  });
});

describe("POST /api/physicians", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("creates a physician", async () => {
    const single = vi.fn(async () => ({
      data: { id: "p1", display_name: "Doe, Jane", alternate_id: "ALT2" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn((table: string) => {
      if (table !== "physician") throw new Error(`unexpected table ${table}`);
      return { insert };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane", alternate_id: "ALT2" }),
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.physician).toEqual({ id: "p1", display_name: "Doe, Jane", alternate_id: "ALT2" });
    expect(insert).toHaveBeenCalledWith({ display_name: "Doe, Jane", alternate_id: "ALT2" });
  });

  it("returns 409 with a clear message on a duplicate alternate_id (unique_violation)", async () => {
    const single = vi.fn(async () => ({
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint \"physician_alternate_id_key\"" },
    }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn((table: string) => {
      if (table !== "physician") throw new Error(`unexpected table ${table}`);
      return { insert };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane", alternate_id: "ALT2" }),
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain("ALT2");
    expect(body.error).toContain("already exists");
  });

  it("rejects a missing display_name", async () => {
    const response = await POST(
      authedRequest("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alternate_id: "ALT2" }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects a missing alternate_id", async () => {
    const response = await POST(
      authedRequest("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane" }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects an alternate_id containing a space (Pioneer's own Alternate ID rule)", async () => {
    const response = await POST(
      authedRequest("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane", alternate_id: "ALT 2" }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/physicians/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("updates the provided fields", async () => {
    const single = vi.fn(async () => ({
      data: { id: "p1", display_name: "Doe, Jane", alternate_id: "ALT3" },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/physicians/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alternate_id: "ALT3" }),
      }),
      { params: Promise.resolve({ id: "p1" }) }
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ alternate_id: "ALT3" });
    expect(eq).toHaveBeenCalledWith("id", "p1");
  });

  it("rejects a body with nothing to update", async () => {
    const response = await PATCH(
      authedRequest("/api/physicians/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "p1" }) }
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects an alternate_id containing a space", async () => {
    const response = await PATCH(
      authedRequest("/api/physicians/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alternate_id: "has space" }),
      }),
      { params: Promise.resolve({ id: "p1" }) }
    );
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/physicians/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("deletes a physician", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await DELETE(new Request("http://localhost/api/physicians/p1", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-token" },
    }), { params: Promise.resolve({ id: "p1" }) });

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("id", "p1");
  });

  it("returns 500 on a Supabase error", async () => {
    const from = vi.fn(() => ({ delete: () => ({ eq: async () => ({ error: new Error("boom") }) }) }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await DELETE(new Request("http://localhost/api/physicians/p1", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-token" },
    }), { params: Promise.resolve({ id: "p1" }) });

    expect(response.status).toBe(500);
  });
});
