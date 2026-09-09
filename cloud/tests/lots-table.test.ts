import { describe, expect, it } from "vitest";
import { isLotRowDue, partitionVaccinesByActive, pickCurrentActiveLot, resolveLotRowHighlight } from "@/lib/lots-table";

describe("resolveLotRowHighlight", () => {
  it("inactive wins over due — an inactive product's expired lot must NOT get the red 'due' style", () => {
    expect(resolveLotRowHighlight(false, true)).toBe("inactive");
  });

  it("an inactive product with no due lot is still 'inactive' (greyed)", () => {
    expect(resolveLotRowHighlight(false, false)).toBe("inactive");
  });

  it("an active product with a due lot is 'due' (red)", () => {
    expect(resolveLotRowHighlight(true, true)).toBe("due");
  });

  it("an active product with no due lot is 'normal' (no highlight)", () => {
    expect(resolveLotRowHighlight(true, false)).toBe("normal");
  });
});

describe("partitionVaccinesByActive", () => {
  it("splits active and inactive vaccines, preserving each group's relative order", () => {
    const vaccines = [
      { id: "1", active: true },
      { id: "2", active: false },
      { id: "3", active: true },
      { id: "4", active: false },
    ];

    const { active, inactive } = partitionVaccinesByActive(vaccines);

    expect(active.map((v) => v.id)).toEqual(["1", "3"]);
    expect(inactive.map((v) => v.id)).toEqual(["2", "4"]);
  });

  it("returns empty arrays for an empty input", () => {
    expect(partitionVaccinesByActive([])).toEqual({ active: [], inactive: [] });
  });

  it("puts everything in inactive when nothing is active", () => {
    const vaccines = [{ id: "1", active: false }];
    expect(partitionVaccinesByActive(vaccines)).toEqual({ active: [], inactive: vaccines });
  });
});

describe("isLotRowDue", () => {
  const today = "2026-09-07";

  it("is not due when both dates are in the future", () => {
    expect(isLotRowDue({ expiration: "2026-09-08", beyond_use_date: "2026-09-10" }, today)).toBe(false);
  });

  it("is due when expiration is in the past", () => {
    expect(isLotRowDue({ expiration: "2026-09-06" }, today)).toBe(true);
  });

  it("is due when expiration is exactly today (inclusive Chicago boundary)", () => {
    expect(isLotRowDue({ expiration: "2026-09-07" }, today)).toBe(true);
  });

  it("is due when beyond_use_date is in the past, even with a future expiration", () => {
    expect(isLotRowDue({ expiration: "2026-12-31", beyond_use_date: "2026-09-01" }, today)).toBe(true);
  });

  it("is due when beyond_use_date is exactly today", () => {
    expect(isLotRowDue({ expiration: "2026-12-31", beyond_use_date: "2026-09-07" }, today)).toBe(true);
  });

  it("ignores a missing/null beyond_use_date (optional field, pre-migration or just unset)", () => {
    expect(isLotRowDue({ expiration: "2026-12-31", beyond_use_date: null }, today)).toBe(false);
    expect(isLotRowDue({ expiration: "2026-12-31" }, today)).toBe(false);
  });

  it("ignores a missing expiration and only looks at beyond_use_date", () => {
    expect(isLotRowDue({ beyond_use_date: "2026-09-01" }, today)).toBe(true);
    expect(isLotRowDue({}, today)).toBe(false);
  });
});

describe("pickCurrentActiveLot", () => {
  it("returns null when there are no lots", () => {
    expect(pickCurrentActiveLot([])).toBeNull();
  });

  it("returns null when no lot has status active", () => {
    expect(pickCurrentActiveLot([{ status: "depleted", expiration: "2026-01-01" }])).toBeNull();
  });

  it("picks the earliest-expiration active lot (FEFO), ignoring depleted lots", () => {
    const lots = [
      { id: "a", status: "active", expiration: "2026-12-01" },
      { id: "b", status: "depleted", expiration: "2026-01-01" },
      { id: "c", status: "active", expiration: "2026-06-01" },
    ];
    expect(pickCurrentActiveLot(lots)?.id).toBe("c");
  });

  it("still returns an EXPIRED active lot (unlike the data-entry flow's unexpired-only picker) — this page's job is to let staff fix it", () => {
    const lots = [{ id: "expired", status: "active", expiration: "2020-01-01" }];
    expect(pickCurrentActiveLot(lots)?.id).toBe("expired");
  });
});
