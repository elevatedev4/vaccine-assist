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

  it("is 'ok' when a lot number is on file and no date has been entered yet", () => {
    expect(lotRowStatus({ lotNumber: "ABC123", expiration: "", beyondUseDate: "", today: TODAY })).toBe("ok");
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
});
