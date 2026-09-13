import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import { reprocessAdministeredAttachments } from "@/lib/administered/reprocess";

// Same in-memory-Map app_setting stand-in pattern
// tests/administered-reprocess-route.test.ts uses, exercised directly
// against the shared lib function (not through the route) so
// scripts/reprocess-administered.ts's --dry-run path is covered
// independently of the HTTP layer.
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
  } as never;
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

describe("reprocessAdministeredAttachments", () => {
  it("dryRun: true lists the vaccination-log attachments it WOULD process without ingesting anything", async () => {
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

    const supabase = fakeSupabase(store);
    const result = await reprocessAdministeredAttachments(supabase, { dryRun: true });

    expect(result).toEqual({
      processed: 0,
      rows: 0,
      matched: 0,
      days: 0,
      skipped: 0,
      attachments: [
        {
          key: "inbound_attachment:2026-09-12T08:01:00.000Z:AppExport.xlsx",
          filename: "AppExport.xlsx",
          receivedAt: "2026-09-12T08:01:00.000Z",
        },
      ],
    });
    // Nothing written — the app_setting store only has the two
    // retained-attachment keys seeded above, no new administered:* row.
    expect([...store.keys()].some((key) => key.startsWith("administered:"))).toBe(false);
  });

  it("without dryRun, ingests and reports the same shape as the route (plus `attachments`)", async () => {
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

    const supabase = fakeSupabase(store);
    const result = await reprocessAdministeredAttachments(supabase);

    expect(result.processed).toBe(1);
    expect(result.rows).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.days).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.attachments).toHaveLength(1);
    expect([...store.keys()].some((key) => key.startsWith("administered:"))).toBe(true);
  });
});
