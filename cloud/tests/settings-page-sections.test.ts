import { describe, expect, it } from "vitest";
import { InstallDesktopAppSection, OtherSettingsLinks } from "@/app/settings/sections";

/**
 * V-cloud-tabs (Will 2026-09-05, fourth message): "other not mentioned
 * pages go within the settings page, include instructions on the
 * settings page to install the app too." Both sections are plain,
 * hook-free function components (like DataEntryInstructions) so they can
 * be called directly and their returned element tree inspected without
 * jsdom/testing-library.
 */
function collectText(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 15) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const el = node as { props?: { children?: unknown } };
  if (el.props && "children" in el.props) collectText(el.props.children, out, depth + 1);
}

function collectHrefs(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 15) return;
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const el = node as { type?: unknown; props?: { href?: unknown; children?: unknown } };
  if (el.type === "a" && typeof el.props?.href === "string") out.push(el.props.href);
  if (el.props && "children" in el.props) collectHrefs(el.props.children, out, depth + 1);
}

describe("OtherSettingsLinks", () => {
  it("links to /vaccines, /physicians, and /settings/sessions", () => {
    const tree = OtherSettingsLinks();
    const hrefs: string[] = [];
    collectHrefs(tree, hrefs);
    expect(hrefs).toContain("/vaccines");
    expect(hrefs).toContain("/physicians");
    expect(hrefs).toContain("/settings/sessions");
  });
});

describe("InstallDesktopAppSection", () => {
  it("links out to the /install tab instead of inlining the old install steps", () => {
    const tree = InstallDesktopAppSection();
    const hrefs: string[] = [];
    collectHrefs(tree, hrefs);
    expect(hrefs).toContain("/install");
  });
});
