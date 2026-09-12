import { afterEach, describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";

vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { POST } from "@/app/api/administered/reprocess/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const CATALOG = [
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad", ndc: null },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii", ndc: null },
];

function fakeSupabase(store: Map<string, unknown>) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return { select: async () => ({ data: CATALOG, error: null }) };
      }
      if (table === "app_setting") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }),
            }),
            like: async (_col: string, pattern: string) => {
              const prefix = pattern.replace(/%$/, "");
              const rows = [...store.entries()]
                .filter(([k]) => k.startsWith(prefix))
                .map(([key, value]) => ({ key, value }));
              return { data: rows, error: null };
            },
          }),
          upsert: async (row: { key: string; value: unknown }) => {
            store.set(row.key, row.value);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function xlsxBase64(aoa: unknown[][]): string {
  const sheet = utils.aoa_to_sheet(aoa);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sheet1");
  return (write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

function retainedAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    receivedAt: "2026-09-12T08:01:00.000Z",
    from: "owner@pioneerrx.example",
    subject: "AppExport",
    filename: "AppExport.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: 100,
    sha256: "abc",
    ...overrides,
  };
}

function authedRequest() {
  return new Request("http://localhost/api/administered/reprocess", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

describe("POST /api/administered/reprocess", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("reprocesses every retained attachment whose header contains 'Completed date' and ingests it", async () => {
    const store = new Map<string, unknown>();
    store.set(
      "inbound_attachment:2026-09-12T08:01:00.000Z:AppExport.xlsx",
      retainedAttachment({
        base64: xlsxBase64([
          ["Completed date", "Item", ""],
          [46275.6416666667, "Flu Quad 2025-26", ""],
          [46275.5, "Unmatched Vaccine", ""],
        ]),
      })
    );
    // A retained BOH-shaped attachment must be skipped (no "Completed date" header).
    store.set(
      "inbound_attachment:2026-09-11T00:00:00.000Z:boh.xlsx",
      retainedAttachment({
        filename: "boh.xlsx",
        base64: xlsxBase64([
          ["Item Name", "NDC/UPC", "Current BOH"],
          ["Flu Quad 2025-26", "12345", 10],
        ]),
      })
    );

    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(store) as never);

    const response = await POST(authedRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ processed: 1, rows: 2, matched: 1, days: 1 });

    const day = store.get("administered:2026-09-10") as { rows: unknown[]; sources: string[] };
    expect(day.rows).toHaveLength(2);
    expect(day.sources).toEqual(["inbound_attachment:2026-09-12T08:01:00.000Z:AppExport.xlsx"]);
  });

  it("is idempotent — reprocessing twice never double-counts a dose", async () => {
    const store = new Map<string, unknown>();
    store.set(
      "inbound_attachment:2026-09-12T08:01:00.000Z:AppExport.xlsx",
      retainedAttachment({
        base64: xlsxBase64([
          ["Completed date", "Item", ""],
          [46275.6416666667, "Flu Quad 2025-26", ""],
        ]),
      })
    );
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(store) as never);

    await POST(authedRequest());
    await POST(authedRequest());

    const day = store.get("administered:2026-09-10") as { rows: unknown[] };
    expect(day.rows).toHaveLength(1);
  });

  it("returns all zeros when nothing retained looks like the vaccination log", async () => {
    const store = new Map<string, unknown>();
    store.set(
      "inbound_attachment:2026-09-11T00:00:00.000Z:boh.xlsx",
      retainedAttachment({
        filename: "boh.xlsx",
        base64: xlsxBase64([
          ["Item Name", "NDC/UPC", "Current BOH"],
          ["Flu Quad 2025-26", "12345", 10],
        ]),
      })
    );
    vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabase(store) as never);

    const response = await POST(authedRequest());
    const body = await response.json();
    expect(body).toEqual({ processed: 0, rows: 0, matched: 0, days: 0 });
  });

  it("requires auth", async () => {
    const { requireAuthenticatedUser } = await import("@/lib/auth");
    vi.mocked(requireAuthenticatedUser).mockResolvedValueOnce({
      error: new Response(null, { status: 401 }) as never,
    } as never);

    const response = await POST(authedRequest());
    expect(response.status).toBe(401);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });
});
