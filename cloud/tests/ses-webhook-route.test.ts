import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { POST } from "@/app/api/webhooks/ses/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CATALOG = [
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
];

// Minimal stand-in matching exactly how the route queries: vaccine ->
// select() resolves directly (no further chaining needed since the route
// awaits the select() result), on_hand_count -> insert(rows).
function fakeSupabaseClient(insert: (rows: unknown[]) => Promise<{ error: unknown }> = vi.fn(async () => ({ error: null }))) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return { select: async () => ({ data: CATALOG, error: null }) };
      }
      if (table === "on_hand_count") {
        return { insert };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function textRequest(text: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...headers },
    body: text,
  });
}

describe("POST /api/webhooks/ses", () => {
  beforeEach(() => {
    delete process.env.SES_WEBHOOK_SECRET;
  });

  afterEach(() => {
    delete process.env.SES_WEBHOOK_SECRET;
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("rejects a request with the wrong secret when SES_WEBHOOK_SECRET is set", async () => {
    process.env.SES_WEBHOOK_SECRET = "correct-secret";
    const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }, { "x-ses-webhook-secret": "wrong" }));
    expect(response.status).toBe(401);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("accepts a request with the correct secret", async () => {
    process.env.SES_WEBHOOK_SECRET = "correct-secret";
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

    const response = await POST(
      jsonRequest({ text: "Flu Quad 2025-26, 10" }, { "x-ses-webhook-secret": "correct-secret" })
    );
    expect(response.status).toBe(200);
  });

  it("parses a JSON { text } body and returns a linesTotal/matchedCount/unmatchedCount summary", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient(insert) as never);

    const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10\nUnknown Vaccine, 3" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ linesTotal: 2, matchedCount: 1, unmatchedCount: 1 });
    expect(insert).toHaveBeenCalledWith([
      { raw_line: "Flu Quad 2025-26, 10", vaccine_name_raw: "Flu Quad 2025-26", quantity: 10, vaccine_id: "v-flu", matched: true },
      { raw_line: "Unknown Vaccine, 3", vaccine_name_raw: "Unknown Vaccine", quantity: 3, vaccine_id: null, matched: false },
    ]);
  });

  it("accepts the { body } alias key in JSON", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

    const response = await POST(jsonRequest({ body: "MMR, 15" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ linesTotal: 1, matchedCount: 1, unmatchedCount: 0 });
  });

  it("treats a text/plain body as the content directly", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

    const response = await POST(textRequest("Flu Quad 2025-26, 10\nMMR, 15"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ linesTotal: 2, matchedCount: 2, unmatchedCount: 0 });
  });

  it("returns a zeroed summary without touching Supabase for empty content", async () => {
    const response = await POST(jsonRequest({ text: "" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns 503 instead of throwing when Supabase is unconfigured", async () => {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase server client requested but not configured.");
    });

    const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }));
    expect(response.status).toBe(503);
  });

  it("returns 500 when the insert fails", async () => {
    vi.mocked(getSupabaseServerClient).mockReturnValue(
      fakeSupabaseClient(vi.fn(async () => ({ error: new Error("boom") }))) as never
    );

    const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }));
    expect(response.status).toBe(500);
  });
});
