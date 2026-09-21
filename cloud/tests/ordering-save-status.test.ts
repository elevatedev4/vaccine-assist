import { describe, expect, it } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { SaveStatusIndicator, TargetInput, targetSaveStatusStyle, type SaveStatus } from "@/app/ordering/target-input";

/**
 * V-T51 (Will, verbatim: "When I update the targets on vaccine order, it
 * shifts the whole table around because of the 'saving' text. Fix that so
 * it doesn't do that.") + its V-T-ordering-target-one-line follow-up
 * (Will, verbatim: "I only want the items to take up one line, not two
 * lines").
 *
 * Root cause of the original shift: the save-status <span> ("saving…" /
 * "saved" / "error") was only mounted while status !== "idle" — every
 * save/blur added or removed a DOM node next to the input. This table has
 * no fixed table-layout, so a column's width tracks its widest cell
 * content, and mounting/unmounting that span changed the "Your target"
 * column's width on every edit, shifting the whole table (same shape of
 * bug as V-T48's "Refreshing…" fix on the macro-codes page).
 *
 * V-T51's own fix kept the <span> permanently mounted and reserved its
 * width in flow with a fixed min-width (saveStatusStyle) — that stopped
 * the table shift, but the reserved width made the "Your target" table
 * cell's content (input + reserved 8ch) wider than the cell, so the
 * browser wrapped the indicator onto its own line under the input, making
 * every row two lines tall instead of one.
 *
 * The one-line fix: SaveStatusIndicator now takes an optional `style` prop
 * (default saveStatusStyle, unchanged, still used by the Walk-up % field
 * in page.tsx, whose row already fits on one line). TargetInput instead
 * passes targetSaveStatusStyle — position:absolute, no min-width/width
 * reservation at all — and wraps just the <input> in a
 * position:relative/display:inline-block/white-space:nowrap span so the
 * indicator anchors beside it without being part of the cell's flow
 * width. The indicator is still permanently mounted (visibility toggles,
 * never conditional rendering), so nothing is added/removed next to the
 * input either.
 *
 * Review follow-up #1: an absolutely positioned indicator with no
 * background sits on top of the next ("BOH") column's number for the ~2s
 * a "saved" message shows, garbling both as overlapping text.
 * targetSaveStatusStyle(...) now also carries a solid background,
 * padding, borderRadius and zIndex:1, so it reads as a small opaque pill
 * covering what's beneath it instead of blending into it.
 *
 * Review follow-up #2: a hard-coded white pill background mismatched
 * order-due rows (page.tsx's trOrderDue, background "#fff8d6").
 * targetSaveStatusStyle is now a function of TargetInput's own
 * `highlighted` prop (page.tsx passes row.order > 0), so the pill matches
 * whichever background the row it sits in actually has.
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
  it("with no style prop (Walk-up %'s usage), defaults to the reserved-width in-flow style — visibility:hidden when idle, not unmounted", () => {
    const el = SaveStatusIndicator({ status: "idle" }) as unknown as Rendered;
    expect(el).toBeTruthy();
    expect(el.type).toBe("span");
    const style = el.props.style as Record<string, unknown>;
    expect(style.minWidth).toBe("8ch");
    expect(style.position).toBeUndefined();
    expect(style.visibility).toBe("hidden");
    expect(el.props["aria-live"]).toBe("polite");
  });

  it("is present (never unmounted) at every save status, and only 'visibility' toggles with status, for both the default and the absolute style", () => {
    for (const style of [undefined, targetSaveStatusStyle(false), targetSaveStatusStyle(true)]) {
      for (const status of ALL_STATUSES) {
        const el = SaveStatusIndicator(style ? { status, style } : { status }) as unknown as Rendered;
        expect(el.type).toBe("span");
        const rendered = el.props.style as Record<string, unknown>;
        expect(rendered.visibility).toBe(status === "idle" ? "hidden" : "visible");
      }
    }
  });

  it("with targetSaveStatusStyle(...) (TargetInput's usage), is positioned absolute and reserves no width in flow", () => {
    const el = SaveStatusIndicator({ status: "saving", style: targetSaveStatusStyle(false) }) as unknown as Rendered;
    const style = el.props.style as Record<string, unknown>;
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("100%");
    expect(style.minWidth).toBeUndefined();
    expect(style.width).toBeUndefined();
  });

  it("with targetSaveStatusStyle(...), paints as an opaque pill (background + padding + borderRadius + zIndex) so it covers the BOH cell text beneath it instead of overlapping it", () => {
    const el = SaveStatusIndicator({ status: "saving", style: targetSaveStatusStyle(false) }) as unknown as Rendered;
    const style = el.props.style as Record<string, unknown>;
    expect(style.background).toBeTruthy();
    expect(style.padding).toBeTruthy();
    expect(style.borderRadius).toBeTruthy();
    expect(style.zIndex).toBe(1);
  });

  it("targetSaveStatusStyle(highlighted) matches the pill background to the row it sits in — white on default rows, order-due yellow on highlighted ones", () => {
    expect(targetSaveStatusStyle(false).background).toBe("#fff");
    expect(targetSaveStatusStyle(true).background).toBe("#fff8d6");
  });

  it("reserves the same width for every message under the default style, including the longest ('saving…') and the error state, so switching between them can't shift anything", () => {
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
  function renderTargetInput(value: number | null, highlighted = false) {
    return ReactDOMServer.renderToStaticMarkup(
      React.createElement(TargetInput, { value, disabled: false, onSave: async () => true, highlighted })
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

  it("positions the status indicator absolutely and reserves no width in flow — the cell's content width is the input's width alone", () => {
    const html = renderTargetInput(5);
    expect(html).toContain("position:absolute");
    expect(html).toContain("left:100%");
    // No min-width reservation anywhere in the rendered markup (the V-T51
    // in-flow "8ch" reservation that caused the two-line wrap is gone).
    expect(html).not.toContain("min-width");
  });

  it("renders the indicator as an opaque pill above the next cell (background + padding + borderRadius + z-index), so status text can't garble the BOH number under it", () => {
    const html = renderTargetInput(5);
    expect(html).toContain("background:#fff");
    expect(html).toContain("border-radius:3px");
    expect(html).toContain("z-index:1");
  });

  it("matches the pill's background to the row's own highlight — plain rows get white, order-due rows (highlighted=true) get the same yellow as styles.trOrderDue", () => {
    const plainRow = renderTargetInput(5, false);
    const orderDueRow = renderTargetInput(5, true);
    expect(plainRow).toContain("background:#fff");
    expect(plainRow).not.toContain("#fff8d6");
    expect(orderDueRow).toContain("background:#fff8d6");
  });

  it("wraps the input in a position:relative, nowrap span so the indicator anchors to it without affecting the cell's own layout", () => {
    const html = renderTargetInput(5);
    expect(html).toContain("position:relative");
    expect(html).toContain("white-space:nowrap");
  });

  it("renders the same number of elements (no added/removed siblings) regardless of the row's target value", () => {
    const withValue = renderTargetInput(5);
    const withoutValue = renderTargetInput(null);
    expect(withValue.match(/<input/g)?.length).toBe(withoutValue.match(/<input/g)?.length);
    expect(withValue.match(/<span/g)?.length).toBe(withoutValue.match(/<span/g)?.length);
  });
});
