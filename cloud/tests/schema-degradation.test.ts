import { describe, expect, it } from "vitest";
import { isMissingColumnError } from "@/lib/schema-degradation";

describe("isMissingColumnError", () => {
  it("recognizes Postgres undefined_column (42703)", () => {
    expect(isMissingColumnError({ code: "42703", message: 'column "beyond_use_date" does not exist' })).toBe(true);
  });

  it("recognizes PostgREST's schema-cache-miss code (PGRST204)", () => {
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'vaccine_group' column" })).toBe(
      true
    );
  });

  it("recognizes a matching message even without a known code", () => {
    expect(isMissingColumnError({ message: 'column vaccine.quantity does not exist' })).toBe(true);
    expect(isMissingColumnError({ message: "Could not find the 'directions' column of 'vaccine'" })).toBe(true);
  });

  it("returns false for an unrelated error", () => {
    expect(isMissingColumnError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(
      false
    );
    expect(isMissingColumnError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for null/undefined/non-object input", () => {
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
    expect(isMissingColumnError("boom")).toBe(false);
  });
});
