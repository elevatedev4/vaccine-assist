import { describe, expect, it } from "vitest";
import { buildAddress, generateToken, ON_HAND_EMAIL_DOMAIN, ON_HAND_EMAIL_LOCAL_PREFIX, parseToken } from "@/lib/on-hand/address";

describe("on-hand address token/address", () => {
  it("round-trips a generated token through buildAddress/parseToken", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const address = buildAddress(token);
    expect(address).toBe(`${ON_HAND_EMAIL_LOCAL_PREFIX}${token}@${ON_HAND_EMAIL_DOMAIN}`);
    expect(parseToken(address)).toBe(token);
  });

  it("generates a different token each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("normalizes an uppercase address to the lowercase token", () => {
    const token = generateToken();
    const address = buildAddress(token).toUpperCase();
    expect(parseToken(address)).toBe(token);
  });

  it("tolerates surrounding whitespace", () => {
    const token = generateToken();
    expect(parseToken(`  ${buildAddress(token)}  `)).toBe(token);
  });

  it("rejects the legacy fixed vaccines-onhand@ address (not a valid hex token)", () => {
    expect(parseToken(`vaccines-onhand@${ON_HAND_EMAIL_DOMAIN}`)).toBeNull();
  });

  it("rejects the wrong domain", () => {
    const token = generateToken();
    expect(parseToken(`${ON_HAND_EMAIL_LOCAL_PREFIX}${token}@capture.orchardsdrug.com`)).toBeNull();
  });

  it("rejects a short token", () => {
    expect(parseToken(`${ON_HAND_EMAIL_LOCAL_PREFIX}abc123@${ON_HAND_EMAIL_DOMAIN}`)).toBeNull();
  });

  it("rejects a non-hex token", () => {
    const notHex = "z".repeat(32);
    expect(parseToken(`${ON_HAND_EMAIL_LOCAL_PREFIX}${notHex}@${ON_HAND_EMAIL_DOMAIN}`)).toBeNull();
  });

  it("rejects an address missing the vaccines- prefix entirely", () => {
    const token = generateToken();
    expect(parseToken(`${token}@${ON_HAND_EMAIL_DOMAIN}`)).toBeNull();
  });

  it("rejects an address with no @ at all", () => {
    expect(parseToken("not-an-email")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseToken("")).toBeNull();
  });

  it("accepts a longer-than-32-char hex token (the 32-hex floor is a minimum, not exact)", () => {
    const longToken = generateToken() + generateToken();
    expect(parseToken(buildAddress(longToken))).toBe(longToken);
  });
});
