import { describe, expect, it } from "vitest";
import { decodeJwtPayload, getSessionIdFromToken } from "@/lib/jwt";

function fakeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a well-formed token's payload", () => {
    const token = fakeToken({ sub: "user-1", session_id: "sess-1" });
    expect(decodeJwtPayload(token)).toEqual({ sub: "user-1", session_id: "sess-1" });
  });

  it("returns null for a malformed token", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
    expect(decodeJwtPayload("")).toBeNull();
  });

  it("returns null when the payload segment isn't valid JSON", () => {
    const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("not-json").toString("base64url")}.sig`;
    expect(decodeJwtPayload(token)).toBeNull();
  });
});

describe("getSessionIdFromToken", () => {
  it("extracts the session_id claim", () => {
    const token = fakeToken({ sub: "user-1", session_id: "sess-abc-123" });
    expect(getSessionIdFromToken(token)).toBe("sess-abc-123");
  });

  it("returns null when session_id is missing or not a string", () => {
    expect(getSessionIdFromToken(fakeToken({ sub: "user-1" }))).toBeNull();
    expect(getSessionIdFromToken(fakeToken({ sub: "user-1", session_id: 123 }))).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(getSessionIdFromToken("garbage")).toBeNull();
  });
});
