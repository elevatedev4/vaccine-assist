"use client";

import { useEffect, useState, type CSSProperties, type KeyboardEvent } from "react";

/**
 * Split out of app/ordering/page.tsx for V-T51 (Will, verbatim: "When I
 * update the targets on vaccine order, it shifts the whole table around
 * because of the 'saving' text. Fix that so it doesn't do that.") — a
 * page.tsx file may only export the Next.js Page fields (default,
 * generateMetadata, ...), so the autosave status indicator + the "Your
 * target" input that uses it live here instead, and page.tsx imports them.
 *
 * Root cause of the shift: the save-status <span> ("saving…" / "saved" /
 * "error") was only mounted while status !== "idle", so every save/blur
 * added or removed a DOM node next to the input. The "Your target"
 * column's table has no fixed table-layout, so its width tracks the
 * widest cell content — mounting/unmounting that span changed the
 * column's width on every edit and shifted the whole table.
 *
 * Fix: SaveStatusIndicator stays permanently mounted at every status;
 * visibility (not conditional rendering) shows/hides the text. Originally
 * (V-T51) the reserved space came from saveStatusStyle's fixed min-width,
 * an in-flow inline-block — that stopped the table from shifting, but
 * Will's follow-up feedback was "I only want the items to take up one
 * line, not two lines": the "Your target" cell's own content (the input)
 * plus the reserved 8ch was wider than the cell, so the browser wrapped
 * the indicator onto its own line under the input, making every row two
 * lines tall instead of one.
 *
 * V-T-ordering-target-one-line fix: TargetInput's own indicator is taken
 * OUT of flow instead — its wrapper span is `position: relative;
 * display: inline-block; white-space: nowrap` around just the input, and
 * SaveStatusIndicator is passed targetSaveStatusStyle (position:absolute,
 * left:100% of the wrapper i.e. right after the input, vertically
 * centered, pointer-events:none) so it reserves NO width or height in
 * flow — the cell's content width is exactly the input's width, same as
 * before V-T51, and nothing wraps or shifts. Checked the "All vaccines"
 * table in page.tsx before picking this over an overlay-inside-the-input
 * placement: Target is column 8 of 12 (BOH/Surplus/Order/Order(pkg)
 * still follow it), and neither the table nor its cells set
 * overflow:hidden/auto anywhere, so text placed past the input's right
 * edge renders in full — it is not clipped by any ancestor. It does still
 * visually sit over the start of the next ("BOH") cell for the ~2s a
 * "saved" message shows — reviewer follow-up caught that this garbled
 * status text over the BOH number, so targetSaveStatusStyle also carries
 * a solid background, padding, borderRadius and zIndex:1, turning it into
 * a small pill that covers what's beneath it instead of overlapping it
 * (see that constant's own comment for the background color choice).
 *
 * The Walk-up % field's own indicator (page.tsx) keeps the original
 * reserved-width saveStatusStyle unchanged — that row (label + input +
 * indicator) fits the settings-menu panel on one line on its own, so the
 * two-line bug never applied there; SaveStatusIndicator's new optional
 * `style` prop defaults to saveStatusStyle for that reason. Same "always
 * mounted, out of flow" idea as V-T48's Refreshing… fix on the
 * macro-codes page, which used position:absolute for the same reason
 * TargetInput now does — its indicator floats over content rather than
 * reserving space.
 */

export type SaveStatus = "idle" | "saving" | "saved" | "error";

// inline-block + nowrap keep this width from collapsing or wrapping onto a
// second line (which would change row height instead of column width).
// Still used for the Walk-up % field's indicator (page.tsx) — that row has
// room, so reserving width in flow there doesn't wrap anything.
export const saveStatusStyle: CSSProperties = {
  fontSize: "0.7rem",
  marginLeft: "0.35rem",
  display: "inline-block",
  minWidth: "8ch",
  whiteSpace: "nowrap",
};

// TargetInput's indicator (V-T-ordering-target-one-line): out of flow, so
// it reserves no width/height — anchored to targetInputWrapperStyle's
// position:relative, sitting just right of the input, vertically centered.
// pointer-events:none so it never intercepts clicks meant for cells past
// the input.
//
// It still visually sits over the start of the "BOH" cell (the next
// column — see page.tsx's "All vaccines" table: no td/table overflow
// clips it, but nothing stops it painting over that cell's own content
// either) for the ~2s a "saved" message shows, which without a background
// meant status text garbled on top of the BOH number. zIndex:1 makes sure
// it paints above that cell's content, and a solid background (+ padding
// + borderRadius) turns it into a small pill that covers what's beneath
// instead of overlapping it. "All vaccines" rows don't share one
// background (default rows are unstyled/white; trOrderDue rows are pale
// yellow #fff8d6 — see page.tsx's styles.trOrderDue) so there's no single
// row color to match; "#fff" is this page's own surface color, reused
// here the same way it's already used for every other panel/card on this
// page (gearButton, menuPanel, modalCard).
export const targetSaveStatusStyle: CSSProperties = {
  position: "absolute",
  left: "100%",
  top: "50%",
  transform: "translateY(-50%)",
  marginLeft: "4px",
  fontSize: "0.7rem",
  whiteSpace: "nowrap",
  pointerEvents: "none",
  background: "#fff",
  padding: "0 4px",
  borderRadius: 3,
  zIndex: 1,
};

const targetInputStyle: CSSProperties = {
  width: 64,
  padding: "1px 4px",
  boxSizing: "border-box",
  border: "1px solid #bbb",
  fontSize: "13px",
};

// Wraps just the <input> (not the indicator, which is positioned relative
// to this). display:inline-block + white-space:nowrap keep this wrapper's
// own width pinned to the input's width — it's the cell's only content, so
// the "Your target" column stays exactly as wide as the input, same as
// before V-T51.
const targetInputWrapperStyle: CSSProperties = {
  position: "relative",
  display: "inline-block",
  whiteSpace: "nowrap",
};

const SAVE_STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "saving…",
  saved: "saved",
  error: "error",
};

const SAVE_STATUS_COLOR: Partial<Record<SaveStatus, string>> = {
  saved: "#0a7d27",
  error: "#b00020",
};

export function SaveStatusIndicator({
  status,
  style = saveStatusStyle,
}: {
  status: SaveStatus;
  /** Defaults to the reserved-width in-flow style (Walk-up %'s usage).
   * TargetInput passes targetSaveStatusStyle instead — see this file's
   * top-of-file doc comment for why the two usages differ. */
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        ...style,
        ...(SAVE_STATUS_COLOR[status] ? { color: SAVE_STATUS_COLOR[status] } : null),
        visibility: status === "idle" ? ("hidden" as const) : ("visible" as const),
      }}
      aria-live="polite"
    >
      {SAVE_STATUS_TEXT[status]}
    </span>
  );
}

/** A single "target on-hand" cell — a row's own NDC-scoped override
 * (V-T26 item 6 removed the group-header version of this control; the
 * group-header cell is now a plain "—" placeholder — see the render in
 * page.tsx). Local editable text, autosaving on blur/Enter; an empty value
 * on save clears the override (PUT targetOnHand: null). */
export function TargetInput({
  value,
  disabled,
  disabledTitle,
  onSave,
}: {
  value: number | null;
  disabled: boolean;
  disabledTitle?: string;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [status, setStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  async function commit() {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setStatus("error");
      return;
    }
    // No-op save (value unchanged) — skip the request but still clear any
    // stale save/error indicator from a previous edit.
    if (parsed === value) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    const ok = await onSave(parsed);
    setStatus(ok ? "saved" : "error");
    if (ok) setTimeout(() => setStatus((current) => (current === "saved" ? "idle" : current)), 2000);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  }

  return (
    <span style={targetInputWrapperStyle}>
      <input
        type="number"
        min={0}
        step={1}
        style={targetInputStyle}
        value={text}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      />
      <SaveStatusIndicator status={status} style={targetSaveStatusStyle} />
    </span>
  );
}
