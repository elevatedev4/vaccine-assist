import { describe, expect, it } from "vitest";
import { DataEntryInstructions } from "@/app/data-entry/instructions";

/**
 * V-cloud-tabs (Will 2026-09-05, second message): "no web data-entry
 * capability — just instructions." Regression guard that the page never
 * regrows a form/input/select — the whole previous guided flow (age ->
 * group -> product -> dose -> clipboard payload) must stay gone.
 * DataEntryInstructions is exported specifically because it's a
 * hook-free function component: it can be called directly and its
 * returned React element tree walked without jsdom/testing-library
 * (this project's vitest.config.ts runs the "node" environment, and has
 * no DOM available) — the sign-in-gated page shell around it uses hooks
 * and can't be called this way.
 */
const FORBIDDEN_ENTRY_TYPES = new Set(["form", "input", "select", "textarea"]);

function collectElementTypes(node: unknown, found: Set<string>, depth = 0): void {
  if (!node || depth > 15) return;
  if (Array.isArray(node)) {
    for (const child of node) collectElementTypes(child, found, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "string") found.add(el.type);
  if (el.props && "children" in el.props) collectElementTypes(el.props.children, found, depth + 1);
}

describe("DataEntryInstructions", () => {
  it("renders no data-entry form controls — instructions only", () => {
    const tree = DataEntryInstructions();
    const types = new Set<string>();
    collectElementTypes(tree, types);

    for (const forbidden of FORBIDDEN_ENTRY_TYPES) {
      expect(types.has(forbidden)).toBe(false);
    }
  });

  it("mentions launching the desktop app and the Ctrl+Keypad2 shortcut", () => {
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

    const tree = DataEntryInstructions();
    const textParts: string[] = [];
    collectText(tree, textParts);
    const text = textParts.join(" ");

    expect(text).toMatch(/desktop app/i);
    expect(text).toMatch(/Rx Profile/i);
    expect(text.toLowerCase()).toContain("ctrl");
    expect(text.toLowerCase()).toContain("keypad 2");
  });
});
