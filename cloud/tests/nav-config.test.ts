import { describe, expect, it } from "vitest";
import { NAV_TABS, buildNavItems, isTabActive, shouldShowNav } from "@/lib/nav-config";

describe("NAV_TABS", () => {
  it("has exactly the six tabs (five from Will's original brief plus Macro codes), in order", () => {
    expect(NAV_TABS.map((t) => t.label)).toEqual(["Schedule", "Ordering", "Data Entry", "Lots", "Macro codes", "Settings"]);
    expect(NAV_TABS.map((t) => t.href)).toEqual([
      "/appointments",
      "/ordering",
      "/data-entry",
      "/lots",
      "/macro-codes",
      "/settings",
    ]);
  });

  it("does not include /vaccines or /physicians as top-level tabs — those live only inside Settings", () => {
    expect(NAV_TABS.some((t) => t.href === "/vaccines")).toBe(false);
    expect(NAV_TABS.some((t) => t.href === "/physicians")).toBe(false);
  });
});

describe("isTabActive", () => {
  it("matches the exact href", () => {
    expect(isTabActive("/lots", "/lots")).toBe(true);
  });

  it("matches a sub-path of the href", () => {
    expect(isTabActive("/lots/123", "/lots")).toBe(true);
  });

  it("does not match an unrelated route that merely shares a prefix", () => {
    expect(isTabActive("/lotsomething", "/lots")).toBe(false);
  });

  it("does not match a different tab's href", () => {
    expect(isTabActive("/ordering", "/lots")).toBe(false);
  });

  it("does not match the home route for any tab", () => {
    for (const tab of NAV_TABS) {
      expect(isTabActive("/", tab.href)).toBe(false);
    }
  });
});

describe("buildNavItems", () => {
  it("marks exactly one tab active per known route", () => {
    for (const tab of NAV_TABS) {
      const items = buildNavItems(tab.href);
      const activeLabels = items.filter((i) => i.active).map((i) => i.label);
      expect(activeLabels).toEqual([tab.label]);
    }
  });

  it("marks /physicians as inside Settings territory but active state is undefined for it directly (no tab owns it)", () => {
    const items = buildNavItems("/physicians");
    expect(items.every((i) => !i.active)).toBe(true);
  });

  it("marks /vaccines the same way — no top-level tab claims it", () => {
    const items = buildNavItems("/vaccines");
    expect(items.every((i) => !i.active)).toBe(true);
  });

  it("preserves NAV_TABS order and shape", () => {
    const items = buildNavItems("/appointments");
    expect(items.map((i) => i.label)).toEqual(NAV_TABS.map((t) => t.label));
  });
});

describe("shouldShowNav", () => {
  it("is false before the session check has resolved, even if a session will turn out to exist", () => {
    expect(shouldShowNav(false, true)).toBe(false);
  });

  it("is false once checked but signed out (MSG-895: no tab bar on the sign-in gate)", () => {
    expect(shouldShowNav(true, false)).toBe(false);
  });

  it("is false while unchecked and signed out", () => {
    expect(shouldShowNav(false, false)).toBe(false);
  });

  it("is true once checked and signed in", () => {
    expect(shouldShowNav(true, true)).toBe(true);
  });
});
