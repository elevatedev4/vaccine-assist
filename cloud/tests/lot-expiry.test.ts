import { describe, expect, it } from "vitest";
import { isLotBlocked, lotExpiryState } from "@/lib/lot-expiry";

const TODAY = "2026-09-25";

describe("lotExpiryState", () => {
  it("is 'expired' when expiration is strictly in the past", () => {
    expect(lotExpiryState({ expiration: "2026-09-24", beyond_use_date: null }, TODAY)).toBe("expired");
  });

  it("is 'ok' when expiration is today (expiring later today is still fine to use)", () => {
    expect(lotExpiryState({ expiration: TODAY, beyond_use_date: null }, TODAY)).toBe("ok");
  });

  it("is 'ok' when expiration is in the future", () => {
    expect(lotExpiryState({ expiration: "2026-09-26", beyond_use_date: null }, TODAY)).toBe("ok");
  });

  it("is 'bud-expired' when beyond_use_date is past but expiration is future", () => {
    expect(lotExpiryState({ expiration: "2026-10-01", beyond_use_date: "2026-09-24" }, TODAY)).toBe("bud-expired");
  });

  it("is 'bud-expired' when beyond_use_date is past and expiration is null", () => {
    expect(lotExpiryState({ expiration: null, beyond_use_date: "2026-09-24" }, TODAY)).toBe("bud-expired");
  });

  it("is 'ok' when both expiration and beyond_use_date are in the future", () => {
    expect(lotExpiryState({ expiration: "2026-10-01", beyond_use_date: "2026-10-15" }, TODAY)).toBe("ok");
  });

  it("is 'ok' when both are null", () => {
    expect(lotExpiryState({ expiration: null, beyond_use_date: null }, TODAY)).toBe("ok");
  });

  it("is 'ok' when both are missing entirely (undefined)", () => {
    expect(lotExpiryState({}, TODAY)).toBe("ok");
  });

  it("reports 'expired' (not 'bud-expired') when both dates are past", () => {
    expect(lotExpiryState({ expiration: "2026-09-01", beyond_use_date: "2026-09-10" }, TODAY)).toBe("expired");
  });

  it("is 'bud-expired' when beyond_use_date is today (strict boundary: today is still OK)", () => {
    expect(lotExpiryState({ expiration: "2026-10-01", beyond_use_date: TODAY }, TODAY)).toBe("ok");
  });
});

describe("isLotBlocked", () => {
  it("is true when expired", () => {
    expect(isLotBlocked({ expiration: "2026-09-24", beyond_use_date: null }, TODAY)).toBe(true);
  });

  it("is true when bud-expired", () => {
    expect(isLotBlocked({ expiration: "2026-10-01", beyond_use_date: "2026-09-24" }, TODAY)).toBe(true);
  });

  it("is false when ok", () => {
    expect(isLotBlocked({ expiration: "2026-10-01", beyond_use_date: "2026-10-15" }, TODAY)).toBe(false);
  });

  it("is false when both dates are null", () => {
    expect(isLotBlocked({ expiration: null, beyond_use_date: null }, TODAY)).toBe(false);
  });
});
