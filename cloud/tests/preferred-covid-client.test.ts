import { describe, expect, it, vi } from "vitest";
import { loadPreferredCovid } from "@/lib/preferred-covid-client";

function fetchReturning(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
}

describe("loadPreferredCovid", () => {
  it("returns the saved setting on success and sends the bearer token", async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ adult: "moderna", kids: "moderna", pending: false }), { status: 200 })
    );
    const result = await loadPreferredCovid("tok", fetchImpl);
    expect(result).toEqual({ ok: true, setting: { adult: "moderna", kids: "moderna" } });
    expect(fetchImpl).toHaveBeenCalledWith("/api/settings/preferred-covid", { headers: { Authorization: "Bearer tok" } });
  });

  it("is a failure (not the defaults) on an HTTP error", async () => {
    expect(await loadPreferredCovid("tok", fetchReturning(new Response("{}", { status: 500 })))).toEqual({ ok: false });
    expect(await loadPreferredCovid("tok", fetchReturning(new Response("{}", { status: 401 })))).toEqual({ ok: false });
  });

  it("is a failure on a network error or an unparseable body", async () => {
    expect(await loadPreferredCovid("tok", fetchReturning(new Error("offline")))).toEqual({ ok: false });
    expect(await loadPreferredCovid("tok", fetchReturning(new Response("not json", { status: 200 })))).toEqual({ ok: false });
    expect(await loadPreferredCovid("tok", fetchReturning(new Response("null", { status: 200 })))).toEqual({ ok: false });
  });

  it("a successful response with nothing saved yields the defaults as a real loaded value", async () => {
    const result = await loadPreferredCovid("tok", fetchReturning(new Response(JSON.stringify({ adult: "pfizer", kids: "moderna", pending: true }), { status: 200 })));
    expect(result).toEqual({ ok: true, setting: { adult: "pfizer", kids: "moderna" } });
  });
});
