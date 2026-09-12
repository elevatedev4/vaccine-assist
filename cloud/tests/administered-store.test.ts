import { describe, expect, it } from "vitest";
import {
  administeredDayKey,
  administeredSummary,
  getAdministeredDay,
  ingestAdministeredRows,
  type AdministeredDay,
} from "@/lib/administered/store";
import type { MatchedAdministeredRow } from "@/lib/administered/match";

// Same in-memory-Map app_setting stand-in pattern
// tests/ses-webhook-route.test.ts uses (a real Map so writes from one
// call are visible to the next, exactly like two ingest runs against the
// same real app_setting row).
function fakeSupabase(options: { store?: Map<string, unknown>; missingTable?: boolean } = {}) {
  const { store = new Map<string, unknown>(), missingTable = false } = options;
  const missingTableError = { code: "42P01", message: 'relation "app_setting" does not exist' };

  return {
    client: {
      from: (table: string) => {
        if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () => {
                if (missingTable) return { data: null, error: missingTableError };
                return { data: store.has(key) ? { value: store.get(key) } : null, error: null };
              },
            }),
          }),
          upsert: async (row: { key: string; value: unknown }) => {
            if (missingTable) return { error: missingTableError };
            store.set(row.key, row.value);
            return { error: null };
          },
        };
      },
    } as never,
    store,
  };
}

function matchedRow(overrides: Partial<MatchedAdministeredRow> = {}): MatchedAdministeredRow {
  return {
    at: "2026-09-10T20:24:00.000Z",
    dateLocal: "2026-09-10",
    itemName: "Fluad Trivalent 2026-27",
    vaccineId: "v-fluad",
    ...overrides,
  };
}

describe("administeredDayKey", () => {
  it("builds the administered:<date> key", () => {
    expect(administeredDayKey("2026-09-10")).toBe("administered:2026-09-10");
  });
});

describe("ingestAdministeredRows", () => {
  it("groups rows by dateLocal and writes one day key per distinct date", async () => {
    const { client, store } = fakeSupabase();
    const rows = [matchedRow(), matchedRow({ at: "2026-09-11T01:00:00.000Z", dateLocal: "2026-09-11", itemName: "Comirnaty" })];

    const result = await ingestAdministeredRows(client, rows, "inbound_attachment:key-1");

    expect(result).toEqual({ rows: 2, days: ["2026-09-10", "2026-09-11"] });
    expect(store.has("administered:2026-09-10")).toBe(true);
    expect(store.has("administered:2026-09-11")).toBe(true);
    const day1 = store.get("administered:2026-09-10") as AdministeredDay;
    expect(day1.rows).toEqual([{ at: rows[0].at, itemName: rows[0].itemName, vaccineId: rows[0].vaccineId }]);
    expect(day1.sources).toEqual(["inbound_attachment:key-1"]);
  });

  it("unions with existing stored rows for the same day rather than overwriting", async () => {
    const { client, store } = fakeSupabase();
    await ingestAdministeredRows(client, [matchedRow()], "source-a");
    await ingestAdministeredRows(client, [matchedRow({ at: "2026-09-10T21:00:00.000Z", itemName: "Comirnaty" })], "source-b");

    const day = store.get("administered:2026-09-10") as AdministeredDay;
    expect(day.rows).toHaveLength(2);
    expect(day.sources).toEqual(["source-a", "source-b"]);
  });

  it("dedupes by (at, itemName) so re-ingesting an overlapping file never double-counts a dose", async () => {
    const { client, store } = fakeSupabase();
    const overlapping = matchedRow();
    await ingestAdministeredRows(client, [overlapping], "day-1-file");
    // Re-sent file carries yesterday's rows too (Will's brief: "future
    // files carry the previous day").
    await ingestAdministeredRows(client, [overlapping, matchedRow({ itemName: "Comirnaty", at: "2026-09-10T22:00:00.000Z" })], "day-2-file");

    const day = store.get("administered:2026-09-10") as AdministeredDay;
    expect(day.rows).toHaveLength(2);
    expect(day.sources).toEqual(["day-1-file", "day-2-file"]);
  });

  it("recording the same sourceKey twice doesn't duplicate it in sources", async () => {
    const { client, store } = fakeSupabase();
    await ingestAdministeredRows(client, [matchedRow()], "same-source");
    await ingestAdministeredRows(client, [matchedRow({ itemName: "Comirnaty" })], "same-source");

    const day = store.get("administered:2026-09-10") as AdministeredDay;
    expect(day.sources).toEqual(["same-source"]);
  });

  it("returns { rows: 0, days: [] } for an empty input without touching Supabase", async () => {
    const { client, store } = fakeSupabase();
    const result = await ingestAdministeredRows(client, [], "source");
    expect(result).toEqual({ rows: 0, days: [] });
    expect(store.size).toBe(0);
  });

  it("degrades to { rows: 0, days: [] } (never throws) when app_setting doesn't exist yet", async () => {
    const { client } = fakeSupabase({ missingTable: true });
    const result = await ingestAdministeredRows(client, [matchedRow()], "source");
    expect(result).toEqual({ rows: 0, days: [] });
  });
});

describe("getAdministeredDay", () => {
  it("returns null for a day with nothing ingested", async () => {
    const { client } = fakeSupabase();
    expect(await getAdministeredDay(client, "2026-09-10")).toBeNull();
  });
});

describe("administeredSummary", () => {
  it("sums rows across the window, splitting matched (byVaccineId) from unmatched", async () => {
    const { client } = fakeSupabase();
    await ingestAdministeredRows(
      client,
      [
        matchedRow({ itemName: "Fluad Trivalent 2026-27", vaccineId: "v-fluad" }),
        matchedRow({ at: "2026-09-10T21:00:00.000Z", itemName: "Fluad Trivalent 2026-27", vaccineId: "v-fluad" }),
        matchedRow({ at: "2026-09-10T22:00:00.000Z", itemName: "Unknown Product", vaccineId: null }),
      ],
      "source"
    );

    const summary = await administeredSummary(client, { days: 3, until: "2026-09-10" });

    expect(summary.since).toBe("2026-09-08");
    expect(summary.until).toBe("2026-09-10");
    expect(summary.days).toBe(3);
    expect(summary.total).toBe(3);
    expect(summary.byVaccineId).toEqual({ "v-fluad": 2 });
    expect(summary.byItemName).toEqual({ "Fluad Trivalent 2026-27": 2, "Unknown Product": 1 });
    expect(summary.unmatched).toBe(1);
  });

  it("contributes zero for a day with nothing ingested, without throwing", async () => {
    const { client } = fakeSupabase();
    const summary = await administeredSummary(client, { days: 7, until: "2026-09-10" });
    expect(summary.total).toBe(0);
    expect(summary.byVaccineId).toEqual({});
    expect(summary.unmatched).toBe(0);
  });

  it("defaults `until` to today in Chicago when omitted", async () => {
    const { client } = fakeSupabase();
    const summary = await administeredSummary(client, { days: 1 });
    expect(summary.since).toBe(summary.until);
  });
});
