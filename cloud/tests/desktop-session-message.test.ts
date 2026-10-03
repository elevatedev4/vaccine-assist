import { describe, expect, it } from "vitest";
import { DESKTOP_SESSION_MESSAGE_TYPE, isDesktopWebViewHost, parseDesktopSessionMessage, shouldApplyPushedSession } from "@/lib/desktop-handoff";

const ACCESS = "a".repeat(40);
const PLACEHOLDER = "desktop-managed-session-no-refresh";

describe("parseDesktopSessionMessage", () => {
  it("accepts the exact message the desktop posts after a refresh", () => {
    expect(
      parseDesktopSessionMessage({ type: DESKTOP_SESSION_MESSAGE_TYPE, access_token: ACCESS, refresh_token: PLACEHOLDER })
    ).toEqual({ access_token: ACCESS, refresh_token: PLACEHOLDER });
  });

  it("uses the same type string the desktop app sends", () => {
    expect(DESKTOP_SESSION_MESSAGE_TYPE).toBe("va-desktop-session");
  });

  it("ignores messages of another type", () => {
    expect(parseDesktopSessionMessage({ type: "something-else", access_token: ACCESS, refresh_token: PLACEHOLDER })).toBeNull();
  });

  it("ignores non-object payloads", () => {
    expect(parseDesktopSessionMessage(null)).toBeNull();
    expect(parseDesktopSessionMessage("va-desktop-session")).toBeNull();
    expect(parseDesktopSessionMessage(42)).toBeNull();
  });

  it("ignores a missing, non-string or implausibly short token", () => {
    expect(parseDesktopSessionMessage({ type: DESKTOP_SESSION_MESSAGE_TYPE, refresh_token: PLACEHOLDER })).toBeNull();
    expect(parseDesktopSessionMessage({ type: DESKTOP_SESSION_MESSAGE_TYPE, access_token: 5, refresh_token: PLACEHOLDER })).toBeNull();
    expect(parseDesktopSessionMessage({ type: DESKTOP_SESSION_MESSAGE_TYPE, access_token: "short", refresh_token: PLACEHOLDER })).toBeNull();
    expect(parseDesktopSessionMessage({ type: DESKTOP_SESSION_MESSAGE_TYPE, access_token: ACCESS, refresh_token: "x" })).toBeNull();
  });
});

describe("isDesktopWebViewHost", () => {
  it("is true only when the WebView2 host object is present", () => {
    expect(isDesktopWebViewHost({ chrome: { webview: {} } })).toBe(true);
  });

  it("is false in an ordinary browser (chrome exists, no webview) and for junk", () => {
    expect(isDesktopWebViewHost({ chrome: {} })).toBe(false);
    expect(isDesktopWebViewHost({})).toBe(false);
    expect(isDesktopWebViewHost(undefined)).toBe(false);
    expect(isDesktopWebViewHost(null)).toBe(false);
  });
});

describe("shouldApplyPushedSession", () => {
  it("skips a push carrying the access token the page already holds", () => {
    expect(shouldApplyPushedSession(ACCESS, ACCESS)).toBe(false);
  });

  it("applies a push with a different token, or when nothing is stored", () => {
    expect(shouldApplyPushedSession("b".repeat(40), ACCESS)).toBe(true);
    expect(shouldApplyPushedSession(null, ACCESS)).toBe(true);
    expect(shouldApplyPushedSession(undefined, ACCESS)).toBe(true);
  });
});
