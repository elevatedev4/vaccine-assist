import { describe, expect, it } from "vitest";
import RootLayout from "@/app/layout";
import TopNav from "@/app/top-nav";

/**
 * Structural check that every page gets the shared tab nav "for free" via
 * the root layout, rather than each page.tsx having to remember to render
 * it. No jsdom/testing-library in this project (vitest.config.ts runs the
 * "node" environment) — RootLayout is a plain server component with no
 * hooks, so it can be called directly as a function and its returned
 * React element tree walked for a TopNav reference, without rendering to
 * a real DOM.
 */
function findElementType(node: unknown, type: unknown, depth = 0): boolean {
  if (!node || depth > 10) return false;
  if (Array.isArray(node)) return node.some((child) => findElementType(child, type, depth + 1));
  if (typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return true;
  if (el.props && "children" in el.props) {
    return findElementType(el.props.children, type, depth + 1);
  }
  return false;
}

describe("RootLayout", () => {
  it("renders TopNav somewhere in the tree, for every page", () => {
    const tree = RootLayout({ children: "page content" as never });
    expect(findElementType(tree, TopNav)).toBe(true);
  });
});
