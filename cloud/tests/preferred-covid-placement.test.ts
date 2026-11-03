import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreferredBadge, PreferredCovidSettingEditor } from "@/app/preferred-covid-setting";

/**
 * The Lots / Entry values / Data Entry pages are sign-in-gated client
 * components full of hooks, and vitest runs in the node environment (no
 * DOM), so they cannot be rendered here. The shared editor and badge are
 * rendered for real with react-dom/server; the three pages are checked at
 * the source level for importing and rendering that same shared component.
 */
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("PreferredCovidSettingEditor rendering", () => {
  it("compact variant shows the labelled block with both age selects", () => {
    const html = renderToStaticMarkup(createElement(PreferredCovidSettingEditor, { accessToken: "t", variant: "compact" }));
    expect(html).toContain("Preferred COVID (C hotkey)");
    expect(html).toContain("Ages 12+");
    expect(html).toContain("Ages 3-11");
    expect(html).toContain("Pfizer 12+");
    expect(html).toContain("Moderna 12+");
    expect(html).toContain("Moderna 3-11");
  });

  it("full variant (Data Entry) still renders the original block", () => {
    const html = renderToStaticMarkup(createElement(PreferredCovidSettingEditor, { accessToken: "t" }));
    expect(html).toContain("Preferred COVID vaccine");
    expect(html).toContain("The C hotkey in the desktop macro list picks this vaccine");
    expect(html).toContain("Ages 12+");
    expect(html).toContain("Ages 3-11");
    expect(html).not.toContain("Preferred COVID (C hotkey)");
  });

  it("badge renders the word Preferred", () => {
    expect(renderToStaticMarkup(createElement(PreferredBadge))).toContain("Preferred");
  });
});

describe("pages use the one shared control", () => {
  const importLine = /import \{[^}]*PreferredCovidSettingEditor[^}]*\} from "@\/app\/preferred-covid-setting";/;

  it("Lots renders the compact editor under the heading and badges rows", () => {
    const src = read("app/lots/page.tsx");
    expect(src).toMatch(importLine);
    expect(src).toMatch(/<h1>Lots<\/h1>\s*<PreferredCovidSettingEditor[^>]*variant="compact"/);
    expect(src).toContain("isPreferredAdultCovidRow(");
    expect(src).toContain("<PreferredBadge />");
  });

  it("Entry values renders the compact editor under the heading and badges rows", () => {
    const src = read("app/entry-values/page.tsx");
    expect(src).toMatch(importLine);
    expect(src).toMatch(/<h1>Entry values<\/h1>\s*<PreferredCovidSettingEditor[^>]*variant="compact"/);
    expect(src).toContain("isPreferredAdultCovidRow(");
    expect(src).toContain("<PreferredBadge />");
  });

  it("Data Entry still renders the editor, from the same shared module", () => {
    const src = read("app/data-entry/page.tsx");
    expect(src).toMatch(importLine);
    expect(src).toContain("<PreferredCovidSettingEditor accessToken={session.accessToken} />");
  });
});
