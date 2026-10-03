import { describe, expect, it } from "vitest";
import { DESKTOP_SESSION_MESSAGE_TYPE, parseDesktopSessionMessage } from "@/lib/desktop-handoff";

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
