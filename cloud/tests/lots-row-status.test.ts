import { describe, expect, it } from "vitest";
import { lotRowExpiredOn, lotRowStatus } from "@/lib/lots-row-status";

const TODAY = "2026-09-14";

describe("lotRowStatus", () => {
  it("is 'missing' when there is no lot number, regardless of dates", () => {
    expect(lotRowStatus({ lotNumber: "", expiration: "", beyondUseDate: "", today: TODAY })).toBe("missing");
    expect(lotRowStatus({ lotNumber: "", expiration: "2026-01-01", beyondUseDate: "", today: TODAY })).toBe("missing");
  });

  it("is 'missing' when the lot number is only whitespace", () => {
    expect(lotRowStatus({ lotNumber: "   ", expiration: "2027-01-01", beyondUseDate: "", today: TODAY })).toBe(
      "missing"
    );
  });

  it("is 'expired' when the expiration date is before today", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "2026-09-13", beyondUseDate: "", today: TODAY })).toBe(
      "expired"
    );
  });

  it("is 'expired' when the beyond-use date is set, earlier than expiration, and before today", () => {
    expect(
      lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: "2026-09-01", today: TODAY })
    ).toBe("expired");
  });

  it("is 'expired' from beyond-use date alone when expiration isn't set", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "", beyondUseDate: "2026-09-01", today: TODAY })).toBe(
      "expired"
    );
  });

  it("is 'ok' when the expiration date is exactly today", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: TODAY, beyondUseDate: "", today: TODAY })).toBe("ok");
  });

  it("is 'ok' when the beyond-use date is exactly today", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: TODAY, today: TODAY })).toBe(
      "ok"
    );
  });

  it("is 'ok' when a lot number is on file and every set date is in the future", () => {
    expect(
      lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: "2026-10-01", today: TODAY })
    ).toBe("ok");
  });

  it("is 'missing-expiration' when a lot number is on file but no expiration date has been entered yet", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "", beyondUseDate: "", today: TODAY })).toBe(
      "missing-expiration"
    );
  });

  it("is 'missing-expiration' when the expiration field holds something that isn't a real calendar date", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "not-a-date", beyondUseDate: "", today: TODAY })).toBe(
      "missing-expiration"
    );
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "2026-02-30", beyondUseDate: "", today: TODAY })).toBe(
      "missing-expiration"
    );
  });

  it("is 'missing' (not 'missing-expiration') when BOTH the lot number and expiration are missing — one message", () => {
    expect(lotRowStatus({ lotNumber: "", expiration: "", beyondUseDate: "", today: TODAY })).toBe("missing");
    expect(lotRowStatus({ lotNumber: "   ", expiration: "", beyondUseDate: "", today: TODAY })).toBe("missing");
  });

  it("is 'expired', not 'missing-expiration', when expiration is missing but the beyond-use date alone is in the past", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "", beyondUseDate: "2026-09-01", today: TODAY })).toBe(
      "expired"
    );
  });

  it("is 'ok' when a lot number AND a valid expiration date are both on file, with no beyond-use date entered", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: "", today: TODAY })).toBe(
      "ok"
    );
  });

  it("treats a null/undefined beyond-use date the same as not set", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: null, today: TODAY })).toBe(
      "ok"
    );
    expect(
      lotRowStatus({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: undefined, today: TODAY })
    ).toBe("ok");
  });

  // Inactive products must never be flagged — enforced by the /lots page
  // never calling lotRowStatus for an inactive row (it hardcodes "ok"
  // instead, see app/lots/page.tsx's renderProductRow), not by this
  // function itself, since lotRowStatus has no notion of active/inactive.
  // This test documents that contract at the call-site level: an
  // inactive row's real (expired/missing) status is exactly what an
  // active row with the same data would get, so the page MUST branch on
  // `view.active` before calling this rather than expecting it to.
  it("has no concept of active/inactive — the page is responsible for skipping inactive rows", () => {
    expect(lotRowStatus({ lotNumber: "", expiration: "2020-01-01", beyondUseDate: "", today: TODAY })).toBe(
      "missing"
    );
  });

  // Same contract as the test above, for the new 'missing-expiration'
  // case: app/lots/page.tsx's renderProductRow only calls lotRowStatus at
  // all when view.active is true (an inactive row hardcodes "ok"
  // instead), so an inactive product's own missing expiration is never
  // flagged — that's enforced at the call site, not in this function.
  it("has no concept of active/inactive for missing-expiration either — same call-site contract", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "", beyondUseDate: "", today: TODAY })).toBe(
      "missing-expiration"
    );
  });

  // V-lots-clear-save follow-up (Will 2026-09-16): expiration is nullable
  // now (supabase/migrations/0014_...) — a lot row read directly from the
  // API (rather than through the /lots page's own "" normalization) can
  // hand this a literal null, and it must flag the same as "".
  it("is 'missing-expiration' when expiration is null (a lot number is on file)", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: null, beyondUseDate: "", today: TODAY })).toBe(
      "missing-expiration"
    );
  });

  it("is 'missing' (not 'missing-expiration') when both lot number and expiration are null/empty", () => {
    expect(lotRowStatus({ lotNumber: "", expiration: null, beyondUseDate: "", today: TODAY })).toBe("missing");
  });

  it("a null expiration doesn't block 'expired' from a past beyond-use date (null is simply excluded as a candidate date)", () => {
    expect(
      lotRowStatus({ lotNumber: "ABC123", expiration: null, beyondUseDate: "2020-01-01", today: TODAY })
    ).toBe("expired");
  });
});

describe("lotRowExpiredOn", () => {
  it("returns the expiration date when that's what made the row expired", () => {
    expect(lotRowExpiredOn({ lotNumber: "ABC123", expiration: "2026-09-13", beyondUseDate: "", today: TODAY })).toBe(
      "2026-09-13"
    );
  });

  it("returns the beyond-use date when it's earlier than expiration and made the row expired", () => {
    expect(
      lotRowExpiredOn({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: "2026-09-01", today: TODAY })
    ).toBe("2026-09-01");
  });

  it("returns null when the row isn't expired", () => {
    expect(lotRowExpiredOn({ lotNumber: "ABC123", expiration: "2026-12-31", beyondUseDate: "", today: TODAY })).toBeNull();
    expect(lotRowExpiredOn({ lotNumber: "ABC123", expiration: TODAY, beyondUseDate: "", today: TODAY })).toBeNull();
  });

  it("returns null when the row is missing rather than expired", () => {
    expect(lotRowExpiredOn({ lotNumber: "", expiration: "2020-01-01", beyondUseDate: "", today: TODAY })).toBeNull();
  });

  it("returns null when the row is missing-expiration rather than expired", () => {
    expect(lotRowExpiredOn({ lotNumber: "ABC123", expiration: "", beyondUseDate: "", today: TODAY })).toBeNull();
  });
});
