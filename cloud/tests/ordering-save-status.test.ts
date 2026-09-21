import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { SaveStatusIndicator, TargetInput, type SaveStatus } from "@/app/ordering/target-input";

/**
 * V-T51 (Will, verbatim: "When I update the targets on vaccine order, it
 * shifts the whole table around because of the 'saving' text. Fix that so
 * it doesn't do that.").
 *
 * Root cause: the "Your target" cell's save-status <span> ("saving…" /
 * "saved" / "error") was only mounted while status !== "idle" — every
 * save/blur added or removed a DOM node next to the input. This table has
 * no fixed table-layout, so a column's width tracks its widest cell
 * content, and mounting/unmounting that span changed the "Your target"
 * column's width on every edit, shifting the whole table (same shape of
 * bug as V-T48's "Refreshing…" fix on the macro-codes page).
 *
 * The fix (SaveStatusIndicator in app/ordering/target-input.tsx) keeps the
 * <span> permanently mounted at every status and reserves its width with
 * saveStatusStyle's fixed min-width — visibility (not conditional
 * rendering) is what shows/hides the text, so nothing can add or remove a
 * sibling node next to the input.
 *
 * No jsdom/testing-library in this project (vitest.config.ts runs the
 * "node" environment — see tests/layout-nav.test.ts's own note on this).
 * SaveStatusIndicator has no hooks, so — like that file's RootLayout
 * check — it's called directly as a plain function and its returned React
 * element inspected, no DOM needed. TargetInput DOES use hooks
 * (useState/useEffect), so it's rendered through react-dom/server's
 * static-markup renderer (a real React render pass, unlike calling the
 * function directly, which would hit React's "invalid hook call" outside
 * a render) to check the actual markup it produces.
 */

type Rendered = { type: unknown; props: Record<string, unknown> };

const ALL_STATUSES: SaveStatus[] = ["idle", "saving", "saved", "error"];

describe("SaveStatusIndicator", () => {
  it("in idle state, is present with the reserved-size style — visibility:hidden, not unmounted", () => {
    const el = SaveStatusIndicator({ status: "idle" }) as unknown as Rendered;
    expect(el).toBeTruthy();
    expect(el.type).toBe("span");
    const style = el.props.style as Record<string, unknown>;
    expect(style.minWidth).toBeTruthy();
    expect(style.visibility).toBe("hidden");
    expect(el.props["aria-live"]).toBe("polite");
  });

  it("is present (never unmounted) at every save status, and only 'visibility' toggles with status — the reserved width stays constant", () => {
    for (const status of ALL_STATUSES) {
      const el = SaveStatusIndicator({ status }) as unknown as Rendered;
      expect(el.type).toBe("span");
      const style = el.props.style as Record<string, unknown>;
      expect(style.minWidth).toBe("8ch");
      expect(style.visibility).toBe(status === "idle" ? "hidden" : "visible");
    }
  });

  it("reserves the same width for every message, including the longest ('saving…') and the error state, so switching between them can't shift anything", () => {
    const rendered = Object.fromEntries(
      ALL_STATUSES.map((status) => [status, SaveStatusIndicator({ status }) as unknown as Rendered])
    ) as Record<SaveStatus, Rendered>;

    expect(rendered.saving.props.children).toBe("saving…");
    expect(rendered.saved.props.children).toBe("saved");
    expect(rendered.error.props.children).toBe("error");

    const widths = ALL_STATUSES.map((status) => (rendered[status].props.style as Record<string, unknown>).minWidth);
    expect(new Set(widths).size).toBe(1);
  });
});

describe("TargetInput (rendered markup)", () => {
  function renderTargetInput(value: number | null) {
    return ReactDOMServer.renderToStaticMarkup(
      React.createElement(TargetInput, { value, disabled: false, onSave: async () => true })
    );
  }

  it("mounts the status span in idle state, as a fixed sibling of the input — hidden via style, not conditionally rendered", () => {
    const html = renderTargetInput(5);
    expect(html.match(/<input/g)?.length).toBe(1);
    // The outer wrapping <span> plus the always-mounted status <span>.
    expect(html.match(/<span/g)?.length).toBe(2);
    expect(html).toContain("visibility:hidden");
    expect(html).toContain('aria-live="polite"');
  });

  it("renders the same number of elements (no added/removed siblings) regardless of the row's target value", () => {
    const withValue = renderTargetInput(5);
    const withoutValue = renderTargetInput(null);
    expect(withValue.match(/<input/g)?.length).toBe(withoutValue.match(/<input/g)?.length);
    expect(withValue.match(/<span/g)?.length).toBe(withoutValue.match(/<span/g)?.length);
  });
});
