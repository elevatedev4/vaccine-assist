import { describe, expect, it } from "vitest";
import { defaultBudEnabledProductKeys, getBudEnabledProductKeys, isValidProductKeyList } from "@/lib/lots-settings";

const VACCINES = [
  { id: "v-fluad", name: "Fluad", ndc: "70461-0123-03", active: true },
  { id: "v-mnexspike", name: "mNEXSPIKE", ndc: null, active: true },
];

describe("isValidProductKeyList", () => {
  it("accepts an array of non-empty strings, including an empty array", () => {
    expect(isValidProductKeyList([])).toBe(true);
    expect(isValidProductKeyList(["name:mnexspike"])).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidProductKeyList("name:mnexspike")).toBe(false);
    expect(isValidProductKeyList([1, 2])).toBe(false);
    expect(isValidProductKeyList([""])).toBe(false);
    expect(isValidProductKeyList(null)).toBe(false);
  });
});

describe("defaultBudEnabledProductKeys", () => {
  it("defaults to mNEXSPIKE's productKey (computed live, not hardcoded)", () => {
    const defaults = defaultBudEnabledProductKeys(VACCINES);
    expect(defaults).toEqual(["name:mnexspike"]);
  });

  it("still finds mNEXSPIKE by its real key even if it later gets an NDC on file", () => {
    const withNdc = [{ id: "v-mnexspike", name: "mNEXSPIKE", ndc: "80777-0401-60", active: true }];
    expect(defaultBudEnabledProductKeys(withNdc)).toEqual(["ndc:80777040160"]);
  });

  it("returns [] when no product resembles mNEXSPIKE at all", () => {
    expect(defaultBudEnabledProductKeys([{ id: "v-fluad", name: "Fluad", ndc: null, active: true }])).toEqual([]);
  });
});

describe("getBudEnabledProductKeys", () => {
  function fakeSupabase(options: { storedValue?: unknown; selectError?: unknown }) {
    const { storedValue, selectError = null } = options;
    return {
      from: (table: string) => {
        if (table !== "app_setting") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                if (selectError) return { data: null, error: selectError };
                if (storedValue === undefined) return { data: null, error: null };
                return { data: { value: storedValue }, error: null };
              },
            }),
          }),
        };
      },
    };
  }

  it("returns the DEFAULT (mNEXSPIKE) with pending:true when app_setting doesn't exist yet", async () => {
    const supabase = fakeSupabase({ selectError: { code: "42P01", message: 'relation "app_setting" does not exist' } });
    const result = await getBudEnabledProductKeys(supabase as never, VACCINES);
    expect(result).toEqual({ productKeys: ["name:mnexspike"], pending: true });
  });

  it("returns the DEFAULT with pending:false when no row has been saved yet", async () => {
    const supabase = fakeSupabase({ storedValue: undefined });
    const result = await getBudEnabledProductKeys(supabase as never, VACCINES);
    expect(result).toEqual({ productKeys: ["name:mnexspike"], pending: false });
  });

  it("returns the SAVED value when present, even if it's an empty array (staff explicitly disabled everything)", async () => {
    const supabase = fakeSupabase({ storedValue: [] });
    const result = await getBudEnabledProductKeys(supabase as never, VACCINES);
    expect(result).toEqual({ productKeys: [], pending: false });
  });

  it("returns a saved multi-product list unchanged", async () => {
    const supabase = fakeSupabase({ storedValue: ["name:mnexspike", "70461012303"] });
    const result = await getBudEnabledProductKeys(supabase as never, VACCINES);
    expect(result.productKeys).toEqual(["name:mnexspike", "70461012303"]);
  });

  it("throws on a genuine (non-missing-table) Supabase error", async () => {
    const supabase = fakeSupabase({ selectError: new Error("connection reset") });
    await expect(getBudEnabledProductKeys(supabase as never, VACCINES)).rejects.toThrow("connection reset");
  });
});
