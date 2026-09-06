import { describe, expect, it } from "vitest";
import {
  buildClipboardPayload,
  formatCashPrice,
  formatExpirationMacro,
  isLotExpired,
  orderByDose,
  pickActiveUnexpiredLot,
  type LotLike,
} from "@/lib/vaccine-entry-payload";

describe("isLotExpired", () => {
  it("is true when expiration is before today", () => {
    expect(isLotExpired("2026-01-01", "2026-09-05")).toBe(true);
  });

  it("is false when expiration is today or after", () => {
    expect(isLotExpired("2026-09-05", "2026-09-05")).toBe(false);
    expect(isLotExpired("2026-12-01", "2026-09-05")).toBe(false);
  });
});

describe("pickActiveUnexpiredLot", () => {
  const today = "2026-09-05";

  it("picks the earliest-expiration active, unexpired lot (FEFO)", () => {
    const lots: LotLike[] = [
      { vaccine_id: "v1", lot_number: "B", expiration: "2027-01-01", status: "active" },
      { vaccine_id: "v1", lot_number: "A", expiration: "2026-10-01", status: "active" },
    ];
    expect(pickActiveUnexpiredLot(lots, today)?.lot_number).toBe("A");
  });

  it("ignores expired lots", () => {
    const lots: LotLike[] = [{ vaccine_id: "v1", lot_number: "OLD", expiration: "2026-01-01", status: "active" }];
    expect(pickActiveUnexpiredLot(lots, today)).toBeNull();
  });

  it("ignores depleted lots even if unexpired", () => {
    const lots: LotLike[] = [
      { vaccine_id: "v1", lot_number: "DEP", expiration: "2027-01-01", status: "depleted" },
    ];
    expect(pickActiveUnexpiredLot(lots, today)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickActiveUnexpiredLot([], today)).toBeNull();
  });

  it("picks the first-listed lot on an exact expiration tie (stable sort)", () => {
    const lots: LotLike[] = [
      { vaccine_id: "v1", lot_number: "FIRST", expiration: "2026-10-01", status: "active" },
      { vaccine_id: "v1", lot_number: "SECOND", expiration: "2026-10-01", status: "active" },
    ];
    expect(pickActiveUnexpiredLot(lots, today)?.lot_number).toBe("FIRST");
    // Reversed input order still wins by POSITION, not by any other
    // tiebreak — locks in "stable sort, first-listed wins" rather than
    // some other implicit tiebreak (e.g. lot_number) creeping in later.
    const reversed = [...lots].reverse();
    expect(pickActiveUnexpiredLot(reversed, today)?.lot_number).toBe("SECOND");
  });
});

describe("formatExpirationMacro", () => {
  it("converts YYYY-MM-DD to MMDDYYYY", () => {
    expect(formatExpirationMacro("2026-09-05")).toBe("09052026");
    expect(formatExpirationMacro("2027-12-31")).toBe("12312027");
  });

  it("throws on a malformed date string", () => {
    expect(() => formatExpirationMacro("2026-09")).toThrow();
    expect(() => formatExpirationMacro("")).toThrow();
  });
});

describe("buildClipboardPayload", () => {
  it("joins shortCode, lot, and expiration with commas", () => {
    expect(buildClipboardPayload("mmr1", "LOT123", "09052026")).toBe("mmr1,LOT123,09052026");
  });

  it("supports blank lot/expiration for the skip-lot case", () => {
    expect(buildClipboardPayload("mmr1", "", "")).toBe("mmr1,,");
  });
});

describe("orderByDose", () => {
  it("orders numerically, not lexicographically", () => {
    const rows = [{ dose: "10" }, { dose: "2" }, { dose: "1" }];
    expect(orderByDose(rows, (r) => r.dose).map((r) => r.dose)).toEqual(["1", "2", "10"]);
  });

  it("puts unparsable doses last, stable by original order", () => {
    const rows = [{ dose: "2" }, { dose: "n/a" }, { dose: "1" }, { dose: null }];
    expect(orderByDose(rows, (r) => r.dose).map((r) => r.dose)).toEqual(["1", "2", "n/a", null]);
  });
});

describe("formatCashPrice", () => {
  it("formats cents as a dollar amount", () => {
    expect(formatCashPrice(14799)).toBe("$147.99");
    expect(formatCashPrice(0)).toBe("$0.00");
  });

  it("returns an em dash for null/undefined", () => {
    expect(formatCashPrice(null)).toBe("—");
    expect(formatCashPrice(undefined)).toBe("—");
  });
});
