import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET, POST } from "@/app/api/physician-rules/route";
import { PATCH, DELETE } from "@/app/api/physician-rules/[id]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { Authorization: "Bearer test-token", ...(init?.headers ?? {}) },
  });
}

describe("GET /api/physician-rules", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("lists every rule when no filter is given", async () => {
    const order = vi.fn(async () => ({ data: [{ id: "r1" }], error: null }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn((table: string) => {
      if (table !== "physician_rule") throw new Error(`unexpected table ${table}`);
      return { select };
    });
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physician-rules"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.physicianRules).toEqual([{ id: "r1" }]);
  });

  it("filters by physicianId when given", async () => {
    const eq = vi.fn(async (column: string, value: string) => {
      expect(column).toBe("physician_id");
      expect(value).toBe("p1");
      return { data: [{ id: "r1", physician_id: "p1" }], error: null };
    });
    const order = vi.fn(() => ({ eq }));
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await GET(authedRequest("/api/physician-rules?physicianId=p1"));
    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("physician_id", "p1");
  });
});

describe("POST /api/physician-rules", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("creates a rule with defaults for omitted optional fields", async () => {
    const single = vi.fn(async () => ({
      data: { id: "r1", physician_id: "p1", vaccine_id: null, min_age: null, max_age: null, priority: 0 },
      error: null,
    }));
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ insert }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await POST(
      authedRequest("/api/physician-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ physician_id: "p1" }),
      })
    );

    expect(response.status).toBe(201);
    expect(insert).toHaveBeenCalledWith({
      physician_id: "p1",
      vaccine_id: null,
      min_age: null,
      max_age: null,
      priority: 0,
    });
  });

  it("rejects a missing physician_id", async () => {
    const response = await POST(
      authedRequest("/api/physician-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("rejects min_age greater than max_age", async () => {
    const response = await POST(
      authedRequest("/api/physician-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ physician_id: "p1", min_age: 20, max_age: 10 }),
      })
    );
    expect(response.status).toBe(400);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/physician-rules/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("updates only the provided fields", async () => {
    const single = vi.fn(async () => ({ data: { id: "r1", priority: 2 }, error: null }));
    const select = vi.fn(() => ({ single }));
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await PATCH(
      authedRequest("/api/physician-rules/r1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: 2 }),
      }),
      { params: Promise.resolve({ id: "r1" }) }
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ priority: 2 });
  });

  it("rejects nothing-to-update", async () => {
    const response = await PATCH(
      authedRequest("/api/physician-rules/r1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "r1" }) }
    );
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/physician-rules/[id]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("deletes a rule", async () => {
    const eq = vi.fn(async () => ({ error: null }));
    const del = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ delete: del }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const response = await DELETE(
      new Request("http://localhost/api/physician-rules/r1", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" },
      }),
      { params: Promise.resolve({ id: "r1" }) }
    );

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("id", "r1");
  });
});
