import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMacroCodesCache,
  fetchMacroCodesPayload,
  isMacroCodesCacheStale,
  MACRO_CODES_CACHE_STALE_MS,
  readMacroCodesCache,
  writeMacroCodesCache,
  type MacroCodesCacheEntry,
  type MacroCodesCacheStorage,
} from "@/lib/macro-codes-cache";

function fakeStorage(initial: Record<string, string> = {}): MacroCodesCacheStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    removeItem: (key: string) => {
      delete data[key];
    },
  };
}

const PAYLOAD = { vaccines: [{ id: "v1" }], lots: [{ id: "l1" }] };

describe("readMacroCodesCache / writeMacroCodesCache / clearMacroCodesCache", () => {
  it("returns null when storage is null/undefined", () => {
    expect(readMacroCodesCache(null, "will@orchardsdrug.com")).toBeNull();
    expect(readMacroCodesCache(undefined, "will@orchardsdrug.com")).toBeNull();
  });

  it("returns null when userEmail is null/undefined/empty", () => {
    const storage = fakeStorage();
    expect(readMacroCodesCache(storage, null)).toBeNull();
    expect(readMacroCodesCache(storage, undefined)).toBeNull();
    expect(readMacroCodesCache(storage, "")).toBeNull();
  });

  it("returns null when nothing is cached yet", () => {
    expect(readMacroCodesCache(fakeStorage(), "will@orchardsdrug.com")).toBeNull();
  });

  it("writeMacroCodesCache persists a payload readMacroCodesCache then reads back", () => {
    const storage = fakeStorage();
    writeMacroCodesCache(storage, "will@orchardsdrug.com", PAYLOAD);
    const entry = readMacroCodesCache(storage, "will@orchardsdrug.com");
    expect(entry?.payload).toEqual(PAYLOAD);
    expect(typeof entry?.fetchedAt).toBe("number");
  });

  it("keys the cache per user — a different email never sees another user's cached payload", () => {
    const storage = fakeStorage();
    writeMacroCodesCache(storage, "will@orchardsdrug.com", PAYLOAD);
    expect(readMacroCodesCache(storage, "someoneelse@orchardsdrug.com")).toBeNull();
  });

  it("keys the cache case-insensitively and trims whitespace, so the same signed-in user always hits the same entry", () => {
    const storage = fakeStorage();
    writeMacroCodesCache(storage, "Will@OrchardsDrug.com", PAYLOAD);
    expect(readMacroCodesCache(storage, "  will@orchardsdrug.com  ")?.payload).toEqual(PAYLOAD);
  });

  it("treats a corrupt (non-JSON) stored value as a cache miss, not a throw", () => {
    const storage = fakeStorage({ "vaccine-assist:macro-codes-cache:will@orchardsdrug.com": "{not json" });
    expect(() => readMacroCodesCache(storage, "will@orchardsdrug.com")).not.toThrow();
    expect(readMacroCodesCache(storage, "will@orchardsdrug.com")).toBeNull();
  });

  it("treats a stored value with the wrong shape (missing vaccines/lots arrays) as a cache miss", () => {
    const storage = fakeStorage({
      "vaccine-assist:macro-codes-cache:will@orchardsdrug.com": JSON.stringify({ fetchedAt: Date.now(), payload: { vaccines: [] } }),
    });
    expect(readMacroCodesCache(storage, "will@orchardsdrug.com")).toBeNull();
  });

  it("never throws when storage.getItem/setItem throw (e.g. a blocked store)", () => {
    const throwingStorage: MacroCodesCacheStorage = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
      removeItem: () => {
        throw new Error("storage blocked");
      },
    };
    expect(() => readMacroCodesCache(throwingStorage, "will@orchardsdrug.com")).not.toThrow();
    expect(readMacroCodesCache(throwingStorage, "will@orchardsdrug.com")).toBeNull();
    expect(() => writeMacroCodesCache(throwingStorage, "will@orchardsdrug.com", PAYLOAD)).not.toThrow();
    expect(() => clearMacroCodesCache(throwingStorage, "will@orchardsdrug.com")).not.toThrow();
  });

  it("writeMacroCodesCache/clearMacroCodesCache are no-ops for null/undefined storage or userEmail", () => {
    expect(() => writeMacroCodesCache(null, "will@orchardsdrug.com", PAYLOAD)).not.toThrow();
    expect(() => writeMacroCodesCache(fakeStorage(), null, PAYLOAD)).not.toThrow();
    expect(() => clearMacroCodesCache(null, "will@orchardsdrug.com")).not.toThrow();
    expect(() => clearMacroCodesCache(fakeStorage(), undefined)).not.toThrow();
  });

  it("clearMacroCodesCache removes a previously written entry", () => {
    const storage = fakeStorage();
    writeMacroCodesCache(storage, "will@orchardsdrug.com", PAYLOAD);
    clearMacroCodesCache(storage, "will@orchardsdrug.com");
    expect(readMacroCodesCache(storage, "will@orchardsdrug.com")).toBeNull();
  });
});

describe("isMacroCodesCacheStale", () => {
  function entryAt(fetchedAt: number): MacroCodesCacheEntry {
    return { payload: PAYLOAD, fetchedAt };
  }

  it("is not stale immediately after fetching", () => {
    const now = 1_000_000;
    expect(isMacroCodesCacheStale(entryAt(now), now)).toBe(false);
  });

  it("is not stale just under the threshold", () => {
    const now = 1_000_000;
    expect(isMacroCodesCacheStale(entryAt(now - (MACRO_CODES_CACHE_STALE_MS - 1)), now)).toBe(false);
  });

  it("is stale once the threshold has elapsed", () => {
    const now = 1_000_000;
    expect(isMacroCodesCacheStale(entryAt(now - MACRO_CODES_CACHE_STALE_MS - 1), now)).toBe(true);
  });

  it("defaults `now` to Date.now() when omitted", () => {
    expect(isMacroCodesCacheStale(entryAt(Date.now()))).toBe(false);
    expect(isMacroCodesCacheStale(entryAt(Date.now() - MACRO_CODES_CACHE_STALE_MS - 10_000))).toBe(true);
  });
});

describe("fetchMacroCodesPayload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok:true with the combined payload on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/vaccines")) return new Response(JSON.stringify({ vaccines: [{ id: "v1" }] }), { status: 200 });
      return new Response(JSON.stringify({ lots: [{ id: "l1" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMacroCodesPayload("token-123");
    expect(result).toEqual({ ok: true, payload: { vaccines: [{ id: "v1" }], lots: [{ id: "l1" }] } });

    expect(fetchMock).toHaveBeenCalledWith("/api/vaccines?includeInactive=true", { headers: { Authorization: "Bearer token-123" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/lots", { headers: { Authorization: "Bearer token-123" } });
  });

  it("reports unauthorized:true on a 401 from /api/vaccines, without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/vaccines")) return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
        return new Response(JSON.stringify({ lots: [] }), { status: 200 });
      })
    );

    const result = await fetchMacroCodesPayload("stale-token");
    expect(result).toEqual({ ok: false, unauthorized: true, message: "expired" });
  });

  it("reports unauthorized:true on a 401 from /api/lots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/vaccines")) return new Response(JSON.stringify({ vaccines: [] }), { status: 200 });
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      })
    );

    const result = await fetchMacroCodesPayload("stale-token");
    expect(result).toEqual({ ok: false, unauthorized: true, message: "expired" });
  });

  it("reports unauthorized:false for a non-401 error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/vaccines")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        return new Response(JSON.stringify({ lots: [] }), { status: 200 });
      })
    );

    const result = await fetchMacroCodesPayload("token");
    expect(result).toEqual({ ok: false, unauthorized: false, message: "boom" });
  });

  it("reports unauthorized:false and a message when fetch itself throws (offline)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    const result = await fetchMacroCodesPayload("token");
    expect(result).toEqual({ ok: false, unauthorized: false, message: "network down" });
  });
});
