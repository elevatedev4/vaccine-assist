import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";

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
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii", ndc: null },
  { id: "v-fluad", name: "Fluad", short_code: "fluad", ndc: "70461-0123-03" },
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

function multipartRequest(filename: string, content: string | ArrayBuffer, type = "text/csv") {
  const formData = new FormData();
  formData.set("file", new File([content], filename, { type }));
  return new Request("http://localhost/api/on-hand/upload", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
    body: formData,
  });
}

function buildXlsxFile(rows: (string | number | null)[][]): ArrayBuffer {
  const sheet = utils.aoa_to_sheet(rows);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sheet1");
  const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return Uint8Array.from(buffer).buffer;
}

// V-onhand-ndc-units: insertOnHandRows now also (best-effort) writes
// vaccine.ndc adoptions after a successful insert — the "vaccine" table
// mock needs an `.update().eq()` chain too, not just `.select()`, for
// any upload whose catalog/report-NDC combination triggers an adoption.
function fakeSupabase(insert: (rows: unknown[]) => Promise<{ error: unknown }> = vi.fn(async () => ({ error: null }))) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return {
          select: async () => ({ data: CATALOG, error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
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

  it("parses a raw text body, inserts rows scoped to the user's address (ndc/stock_size null for a legacy line), and reports one unmatched line", async () => {
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
        ndc: null,
        stock_size: null,
      },
      {
        raw_line: "MMR, 15",
        vaccine_name_raw: "MMR",
        quantity: 15,
        vaccine_id: "v-mmr",
        matched: true,
        inbound_email_address_id: "addr-1",
        source: "upload",
        ndc: null,
        stock_size: null,
      },
      {
        raw_line: "Unknown Vaccine, 3",
        vaccine_name_raw: "Unknown Vaccine",
        quantity: 3,
        vaccine_id: null,
        matched: false,
        inbound_email_address_id: "addr-1",
        source: "upload",
        ndc: null,
        stock_size: null,
      },
    ]);
    // touchLastReceived is deliberately NOT called from the upload path
    // (V-T25) — GET /api/on-hand/address's lastReceivedAt now drives the
    // Ordering page's "set up your email" popup, and that decision must
    // reflect an actual EMAIL received, never a manual upload.
    expect(touchLastReceived).not.toHaveBeenCalled();
    // One batch insert, not one per row (review fix follow-up sanity
    // check) — the whole point of insertOnHandRows is a single
    // batched call.
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("accepts a multipart/form-data csv file upload the same way", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const response = await POST(multipartRequest("onhand.csv", "Flu Quad 2025-26, 10"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ inserted: 1, unmatched: [] });
  });

  it("accepts a Pioneer-shaped xlsx upload, matching by NDC and computing doses", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const xlsx = buildXlsxFile([
      ["Item Name", "NDC/UPC", "Current BOH"],
      [null, null, null, "Stock size"],
      ["Fluad 2026-2027 Syringe", "70461002303", 57.5, 0.5],
    ]);
    const response = await POST(
      multipartRequest(
        "boh.xlsx",
        xlsx,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ inserted: 1, unmatched: [] });
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        vaccine_id: "v-fluad",
        quantity: 115, // round(57.5 / 0.5)
        matched: true,
        ndc: "70461002303",
        stock_size: 0.5,
        inbound_email_address_id: "addr-1",
        source: "upload",
      }),
    ]);
  });

  it("rejects a raw body over the 2MB cap without touching Supabase", async () => {
    const oversized = "a".repeat(MAX_UPLOAD_BYTES + 1);

    const response = await POST(textRequest(oversized));

    expect(response.status).toBe(400);
    expect(getOrCreateAddressForUser).not.toHaveBeenCalled();
  });

  it("rejects a multipart file over the 2MB cap", async () => {
    const oversized = "a".repeat(MAX_UPLOAD_BYTES + 1);
    const response = await POST(multipartRequest("onhand.csv", oversized));
    expect(response.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const response = await POST(textRequest("   \n  "));
    expect(response.status).toBe(400);
  });

  it("succeeds without an address when inbound_email_address doesn't exist yet (0010 pending) — inserts the 0006-only shape", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue({
      code: "42P01",
      message: 'relation "inbound_email_address" does not exist',
    });
    const insert = vi.fn(async () => ({ error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const response = await POST(textRequest("Flu Quad 2025-26, 10"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ inserted: 1, unmatched: [] });
    expect(insert).toHaveBeenCalledWith([
      {
        raw_line: "Flu Quad 2025-26, 10",
        vaccine_name_raw: "Flu Quad 2025-26",
        quantity: 10,
        vaccine_id: "v-flu",
        matched: true,
        ndc: null,
        stock_size: null,
      },
    ]);
  });

  it("returns 503 for a genuine Supabase misconfiguration (not just a missing-table 0010 gap)", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue(new Error("Supabase server client requested but not configured."));

    const response = await POST(textRequest("Flu Quad 2025-26, 10"));
    expect(response.status).toBe(503);
  });

  it("retries the insert without ndc/stock_size when those columns don't exist yet (0011 pending)", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: "42703", message: 'column "ndc" of relation "on_hand_count" does not exist' } })
      .mockResolvedValueOnce({ error: null });
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(insert) as never);

    const response = await POST(textRequest("Flu Quad 2025-26, 10"));

    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenLastCalledWith([
      {
        raw_line: "Flu Quad 2025-26, 10",
        vaccine_name_raw: "Flu Quad 2025-26",
        quantity: 10,
        vaccine_id: "v-flu",
        matched: true,
        inbound_email_address_id: "addr-1",
        source: "upload",
      },
    ]);
  });
});
