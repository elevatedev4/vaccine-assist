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
 * status text over the BOH number, so targetSaveStatusStyle() also
 * carries a solid background, padding, borderRadius and zIndex:1, turning
 * it into a small pill that covers what's beneath it instead of
 * overlapping it. Second reviewer follow-up: a hard-coded white pill
 * background mismatched order-due rows (page.tsx's trOrderDue,
 * background "#fff8d6" — a highlighted row highlighted, verbatim, "to
 * indicate action is needed"). The Target <td> has no background of its
 * own (styles.td), so — per the "a td's own background always paints
 * over its parent tr's" note at page.tsx:247-251 — it, and the BOH <td>
 * the pill sits over, both show whatever the <tr> painted: white by
 * default, or "#fff8d6" when order-due. targetSaveStatusStyle is now a
 * function of that row's own highlighted flag so the pill always matches
 * what's actually behind it, instead of assuming white.
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
// instead of overlapping it.
//
// The background must follow the row, not a fixed white: "All vaccines"
// rows don't share one background (default rows are unstyled/white;
// order-due rows are pale yellow "#fff8d6" — styles.trOrderDue), and
// since the Target/BOH <td>s have no background of their own, both show
// whatever the <tr> painted (page.tsx:247-251's own note that a td's own
// background always wins over its tr's — these cells have none, so the
// tr's does). `highlighted` is TargetInput's own row.order > 0 flag,
// threaded straight through from its caller in page.tsx.
export function targetSaveStatusStyle(highlighted: boolean): CSSProperties {
  return {
    position: "absolute",
    left: "100%",
    top: "50%",
    transform: "translateY(-50%)",
    marginLeft: "4px",
    fontSize: "0.7rem",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    background: highlighted ? "#fff8d6" : "#fff",
    padding: "0 4px",
    borderRadius: 3,
    zIndex: 1,
  };
}

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
  highlighted,
}: {
  value: number | null;
  disabled: boolean;
  disabledTitle?: string;
  onSave: (value: number | null) => Promise<boolean>;
  /** True when this row is order-due (page.tsx's row.order > 0 /
   * styles.trOrderDue) — matches the status pill's background to that
   * row's actual highlight color instead of assuming white. */
  highlighted: boolean;
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
      <SaveStatusIndicator status={status} style={targetSaveStatusStyle(highlighted)} />
    </span>
  );
}

// "Ordered today" input's own style (V-ordering-ordered-today, Will
// 2026-09-25) — narrower than targetInputStyle (48 vs 64) since a
// packages-ordered count is realistically 1-2 digits, keeping the "To
// order" table's new column no wider than it needs to be.
const orderedTodayInputStyle: CSSProperties = {
  width: 48,
  padding: "1px 4px",
  boxSizing: "border-box",
  border: "1px solid #bbb",
  fontSize: "13px",
};

/**
 * The "To order" table's per-row "Ordered today" cell (V-ordering-
 * ordered-today, Will 2026-09-25 verbatim: "Add a field to the
 * table/recommended order where I can enter the # packages I have
 * ordered for today") — a packages count, always a non-negative
 * integer, autosaving on blur/Enter via PUT /api/ordering/ordered-today
 * (app/ordering/page.tsx's saveOrderedToday). Same local-editable-text +
 * SaveStatusIndicator shape as TargetInput above, simplified: there's no
 * "clear to fall back to a recommendation" concept here (contrast
 * TargetInput's targetOnHand override) — an empty field just commits as
 * 0, the same value a brand-new Chicago day implicitly starts at.
 *
 * `highlighted` mirrors TargetInput's own flag: true for a row still in
 * the main "To order" list (pale-yellow-free here, since the To order
 * table has no trOrderDue-style row highlight of its own — always
 * passed false by page.tsx's callers, kept as a parameter only so this
 * reuses the exact same targetSaveStatusStyle(highlighted) pill-
 * background logic TargetInput already established rather than
 * duplicating it with a hard-coded background).
 */
export function OrderedTodayInput({
  value,
  disabled,
  disabledTitle,
  onSave,
  highlighted = false,
}: {
  value: number;
  disabled?: boolean;
  disabledTitle?: string;
  onSave: (value: number) => Promise<boolean>;
  highlighted?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [status, setStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    setText(String(value));
  }, [value]);

  async function commit() {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setStatus("error");
      return;
    }
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
        style={orderedTodayInputStyle}
        value={text}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      />
      <SaveStatusIndicator status={status} style={targetSaveStatusStyle(highlighted)} />
    </span>
  );
}
