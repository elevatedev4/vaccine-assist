import { describe, expect, it, vi } from "vitest";
import { insertOnHandRows } from "@/lib/on-hand/insert";
import type { MatchedOnHandRow } from "@/lib/on-hand/pioneer-boh";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

function row(overrides: Partial<MatchedOnHandRow>): MatchedOnHandRow {
  return {
    rawLine: "line",
    vaccineNameRaw: "Product",
    quantity: 10,
    vaccineId: "v1",
    matched: true,
    ndc: null,
    stockSize: 1,
    matchedByExactNdc: false,
    ...overrides,
  };
}

// Minimal fake Supabase client: `from("on_hand_count")` supports insert,
// `from("vaccine")` supports update().eq() — records every update call
// for assertions.
function fakeSupabase(insertResult: { error: unknown } = { error: null }) {
  const updateCalls: { table: string; payload: unknown; id: string }[] = [];
  const insert = vi.fn(async () => insertResult);
  const client = {
    from: (table: string) => {
      if (table === "on_hand_count") return { insert };
      if (table === "vaccine") {
        return {
          update: (payload: unknown) => ({
            eq: async (_col: string, id: string) => {
              updateCalls.push({ table, payload, id });
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, insert, updateCalls };
}

describe("insertOnHandRows — NDC reconciliation wiring (V-onhand-ndc-units)", () => {
  it("does nothing NDC-related when no catalog is given (opt-in, no extra round-trip)", async () => {
    const { client, updateCalls } = fakeSupabase();
    const rows = [row({ vaccineId: "v1", ndc: "70461002603" })];

    const { error } = await insertOnHandRows(client as never, rows, {});
    expect(error).toBeNull();
    expect(updateCalls).toEqual([]);
  });

  it("adopts the report NDC onto vaccine.ndc when a catalog is given and the decision function finds an adoption", async () => {
    const { client, updateCalls } = fakeSupabase();
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    const { error } = await insertOnHandRows(client as never, rows, {}, catalog);
    expect(error).toBeNull();
    expect(updateCalls).toEqual([{ table: "vaccine", payload: { ndc: "70461-0026-03" }, id: "v1" }]);
  });

  it("logs the adoption", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = fakeSupabase();
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    await insertOnHandRows(client as never, rows, {}, catalog);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("NDC adopted from Pioneer report: Fluad"));
    logSpy.mockRestore();
  });

  it("logs a tie and does NOT call update when two lines tie for a product's highest stock but disagree on NDC", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, updateCalls } = fakeSupabase();
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [
      row({ vaccineId: "v1", ndc: "70461002603", quantity: 40, matchedByExactNdc: false }),
      row({ vaccineId: "v1", ndc: "70461002604", quantity: 40, matchedByExactNdc: false }),
    ];

    await insertOnHandRows(client as never, rows, {}, catalog);
    expect(updateCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("tied for highest stock"));
    warnSpy.mockRestore();
  });

  it("logs no-stock and does NOT call update when every line for a product has zero stock", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, updateCalls } = fakeSupabase();
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", quantity: 0, matchedByExactNdc: false })];

    await insertOnHandRows(client as never, rows, {}, catalog);
    expect(updateCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no stock on any line"));
    warnSpy.mockRestore();
  });

  it("does NOT attempt reconciliation when the on_hand_count insert itself failed", async () => {
    const { client, updateCalls } = fakeSupabase({ error: { message: "boom" } });
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    const { error } = await insertOnHandRows(client as never, rows, {}, catalog);
    expect(error).toEqual({ message: "boom" });
    expect(updateCalls).toEqual([]);
  });

  it("swallows a failed vaccine.ndc update and still reports the on_hand_count insert as successful", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insert = vi.fn(async () => ({ error: null }));
    const client = {
      from: (table: string) => {
        if (table === "on_hand_count") return { insert };
        if (table === "vaccine") {
          return { update: () => ({ eq: async () => ({ error: { message: "update failed" } } as { error: unknown }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    const catalog: CatalogVaccine[] = [{ id: "v1", name: "Fluad", ndc: "70461-0123-03" }];
    const rows = [row({ vaccineId: "v1", ndc: "70461002603", matchedByExactNdc: false })];

    const { error } = await insertOnHandRows(client as never, rows, {}, catalog);
    expect(error).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
