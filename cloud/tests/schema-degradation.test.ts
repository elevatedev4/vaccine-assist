import { describe, expect, it } from "vitest";
import { isMissingColumnError, isMissingFunctionError } from "@/lib/schema-degradation";

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

describe("isMissingFunctionError", () => {
  it("recognizes Postgres undefined_function (42883)", () => {
    expect(isMissingFunctionError({ code: "42883", message: "function list_my_sessions(uuid) does not exist" })).toBe(
      true
    );
  });

  it("recognizes PostgREST's schema-cache-miss code (PGRST202)", () => {
    expect(
      isMissingFunctionError({ code: "PGRST202", message: "Could not find the function public.list_my_sessions" })
    ).toBe(true);
  });

  it("recognizes a matching message even without a known code", () => {
    expect(isMissingFunctionError({ message: "function revoke_my_session does not exist" })).toBe(true);
  });

  it("returns false for an unrelated error", () => {
    expect(isMissingFunctionError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(
      false
    );
    expect(isMissingFunctionError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for null/undefined/non-object input", () => {
    expect(isMissingFunctionError(null)).toBe(false);
    expect(isMissingFunctionError(undefined)).toBe(false);
    expect(isMissingFunctionError("boom")).toBe(false);
  });
});
