import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/on-hand/address", () => ({
  getOrCreateAddressForUser: vi.fn(),
  touchLastReceived: vi.fn(async () => {}),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { POST } from "@/app/api/on-hand/upload/route";
import { MAX_UPLOAD_BYTES } from "@/lib/on-hand/upload";
import { getOrCreateAddressForUser, touchLastReceived } from "@/lib/on-hand/address";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CATALOG = [
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
];

const ADDRESS = {
  id: "addr-1",
  userId: "user-1",
  token: "0123456789abcdef0123456789abcdef",
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastReceivedAt: null as string | null,
};

function textRequest(text: string) {
  return new Request("http://localhost/api/on-hand/upload", {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: "Bearer test-token" },
    body: text,
  });
}

function multipartRequest(filename: string, content: string) {
  const formData = new FormData();
  formData.set("file", new File([content], filename, { type: "text/csv" }));
  return new Request("http://localhost/api/on-hand/upload", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
    body: formData,
  });
}

function fakeSupabase(insert: (rows: unknown[]) => Promise<{ error: unknown }> = vi.fn(async () => ({ error: null }))) {
  return {
    from: (table: string) => {
      if (table === "vaccine") return { select: async () => ({ data: CATALOG, error: null }) };
      if (table === "on_hand_count") return { insert };
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe("POST /api/on-hand/upload", () => {
  afterEach(() => {
    vi.mocked(getOrCreateAddressForUser).mockReset();
    vi.mocked(touchLastReceived).mockReset();
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("parses a raw text body, inserts rows scoped to the user's address, and reports one unmatched line", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const response = await POST(
      textRequest("Flu Quad 2025-26, 10\nMMR, 15\nUnknown Vaccine, 3")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ inserted: 3, unmatched: ["Unknown Vaccine"] });
    expect(insert).toHaveBeenCalledWith([
      {
        raw_line: "Flu Quad 2025-26, 10",
        vaccine_name_raw: "Flu Quad 2025-26",
        quantity: 10,
        vaccine_id: "v-flu",
        matched: true,
        inbound_email_address_id: "addr-1",
        source: "upload",
      },
      {
        raw_line: "MMR, 15",
        vaccine_name_raw: "MMR",
        quantity: 15,
        vaccine_id: "v-mmr",
        matched: true,
        inbound_email_address_id: "addr-1",
        source: "upload",
      },
      {
        raw_line: "Unknown Vaccine, 3",
        vaccine_name_raw: "Unknown Vaccine",
        quantity: 3,
        vaccine_id: null,
        matched: false,
        inbound_email_address_id: "addr-1",
        source: "upload",
      },
    ]);
    expect(touchLastReceived).toHaveBeenCalledWith("addr-1");
  });

  it("accepts a multipart/form-data file upload the same way", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const response = await POST(multipartRequest("onhand.csv", "Flu Quad 2025-26, 10"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ inserted: 1, unmatched: [] });
  });

  it("rejects a raw body over the 200KB cap without touching Supabase", async () => {
    const oversized = "a".repeat(MAX_UPLOAD_BYTES + 1);

    const response = await POST(textRequest(oversized));

    expect(response.status).toBe(400);
    expect(getOrCreateAddressForUser).not.toHaveBeenCalled();
  });

  it("rejects a multipart file over the 200KB cap", async () => {
    const oversized = "a".repeat(MAX_UPLOAD_BYTES + 1);
    const response = await POST(multipartRequest("onhand.csv", oversized));
    expect(response.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const response = await POST(textRequest("   \n  "));
    expect(response.status).toBe(400);
  });

  it("returns 503 when the migration hasn't been applied yet", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue({
      code: "42P01",
      message: 'relation "inbound_email_address" does not exist',
    });

    const response = await POST(textRequest("Flu Quad 2025-26, 10"));
    expect(response.status).toBe(503);
  });
});
