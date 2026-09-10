import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "user-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/on-hand/address", () => ({
  getOrCreateAddressForUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/on-hand/latest/route";
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
  return new Request("http://localhost/api/on-hand/latest", { headers: { Authorization: "Bearer test-token" } });
}

// Same stand-in shape as tests/ordering-recommendation-route.test.ts's
// on_hand_count mock: `.or(...)` parses just enough of the real
// PostgREST filter string to filter rows the same way Postgres would;
// `.order(...)` (no `.or()` first) is the unscoped fallback path.
function fakeSupabase(onHandRows: Record<string, unknown>[]) {
  return {
    from: (table: string) => {
      if (table !== "on_hand_count") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          or: (filter: string) => {
            const match = filter.match(/inbound_email_address_id\.eq\.([^,]+)/);
            const allowedId = match ? match[1] : null;
            const filtered = onHandRows.filter(
              (row) => row.inbound_email_address_id === allowedId || row.inbound_email_address_id == null
            );
            return { order: async () => ({ data: filtered, error: null }) };
          },
          order: async () => ({ data: onHandRows, error: null }),
        }),
      };
    },
  };
}

describe("GET /api/on-hand/latest", () => {
  afterEach(() => {
    vi.mocked(getOrCreateAddressForUser).mockReset();
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("returns lines: [] when there are no on_hand_count rows at all", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase([]) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ lines: [] });
  });

  it("returns every row within 120s of the newest row, same source, in the response shape", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const rows = [
      {
        vaccine_name_raw: "Fluad 2026-2027 Syringe",
        ndc: "70461002603",
        stock_size: 0.5,
        quantity: 115,
        vaccine_id: "v-fluad",
        matched: true,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
        inbound_email_address_id: "addr-1",
      },
      {
        vaccine_name_raw: "Abrysvo Vial",
        ndc: "00069246501",
        stock_size: 1,
        quantity: 9,
        vaccine_id: "v-abrysvo",
        matched: true,
        received_at: "2026-09-10T18:00:00.457Z", // same batch, 457ms later
        source: "email",
        inbound_email_address_id: "addr-1",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lines).toEqual([
      {
        vaccineNameRaw: "Fluad 2026-2027 Syringe",
        ndc: "70461002603",
        stockSize: 0.5,
        quantity: 115,
        vaccineId: "v-fluad",
        matched: true,
        receivedAt: "2026-09-10T18:00:00.000Z",
      },
      {
        vaccineNameRaw: "Abrysvo Vial",
        ndc: "00069246501",
        stockSize: 1,
        quantity: 9,
        vaccineId: "v-abrysvo",
        matched: true,
        receivedAt: "2026-09-10T18:00:00.457Z",
      },
    ]);
  });

  it("includes an UNMATCHED row from the latest batch (verifying reconciliation needs to see why it didn't resolve)", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const rows = [
      {
        vaccine_name_raw: "Totally Unknown Product",
        ndc: "55555555555",
        stock_size: 1,
        quantity: null,
        vaccine_id: null,
        matched: false,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
        inbound_email_address_id: "addr-1",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ matched: false, vaccineId: null, quantity: null });
  });

  it("excludes a row OLDER than the 120s batch window", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const rows = [
      {
        vaccine_name_raw: "Fresh Product",
        ndc: "11111111111",
        stock_size: 1,
        quantity: 10,
        vaccine_id: "v1",
        matched: true,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
        inbound_email_address_id: "addr-1",
      },
      {
        vaccine_name_raw: "Stale Product",
        ndc: "22222222222",
        stock_size: 1,
        quantity: 5,
        vaccine_id: "v2",
        matched: true,
        received_at: "2026-09-10T17:55:00.000Z", // 5 minutes earlier — outside the 120s window
        source: "email",
        inbound_email_address_id: "addr-1",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].vaccineNameRaw).toBe("Fresh Product");
  });

  it("excludes a same-timeframe row from a DIFFERENT source (the newest row's source wins)", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const rows = [
      {
        vaccine_name_raw: "Email Product",
        ndc: "11111111111",
        stock_size: 1,
        quantity: 10,
        vaccine_id: "v1",
        matched: true,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
        inbound_email_address_id: "addr-1",
      },
      {
        vaccine_name_raw: "Upload Product",
        ndc: "22222222222",
        stock_size: 1,
        quantity: 5,
        vaccine_id: "v2",
        matched: true,
        received_at: "2026-09-10T18:00:01.000Z",
        source: "upload",
        inbound_email_address_id: "addr-1",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    // Newest row overall is the upload row (18:00:01 > 18:00:00), so the
    // email row (different source) is excluded from ITS batch.
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].vaccineNameRaw).toBe("Upload Product");
  });

  it("scopes rows to this account's inbound address plus legacy null-address rows", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const rows = [
      {
        vaccine_name_raw: "Mine",
        ndc: "11111111111",
        stock_size: 1,
        quantity: 10,
        vaccine_id: "v1",
        matched: true,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
        inbound_email_address_id: "addr-1",
      },
      {
        vaccine_name_raw: "Someone Else's",
        ndc: "22222222222",
        stock_size: 1,
        quantity: 5,
        vaccine_id: "v2",
        matched: true,
        received_at: "2026-09-10T18:00:01.000Z",
        source: "email",
        inbound_email_address_id: "addr-OTHER",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    const body = await response.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].vaccineNameRaw).toBe("Mine");
  });

  it("falls back to an unscoped query (never errors) when inbound_email_address doesn't exist yet (0010 pending)", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue({
      code: "42P01",
      message: 'relation "inbound_email_address" does not exist',
    });
    const rows = [
      {
        vaccine_name_raw: "Legacy Row",
        ndc: null,
        stock_size: null,
        quantity: 10,
        vaccine_id: "v1",
        matched: true,
        received_at: "2026-09-10T18:00:00.000Z",
        source: "email",
      },
    ];
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(rows) as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lines).toHaveLength(1);
  });

  it("returns 503 for an unrelated address-resolution failure", async () => {
    vi.mocked(getOrCreateAddressForUser).mockRejectedValue(new Error("connection reset"));

    const response = await GET(authedRequest());
    expect(response.status).toBe(503);
  });

  it("returns 500 when the on_hand_count query itself fails", async () => {
    vi.mocked(getOrCreateAddressForUser).mockResolvedValue(ADDRESS);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getSupabaseServerClient).mockReturnValue({
      from: () => ({
        select: () => ({
          or: () => ({ order: async () => ({ data: null, error: new Error("boom") }) }),
        }),
      }),
    } as never);

    const response = await GET(authedRequest());
    expect(response.status).toBe(500);
    errorSpy.mockRestore();
  });
});
