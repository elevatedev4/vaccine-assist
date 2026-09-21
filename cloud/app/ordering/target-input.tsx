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
 * visibility (not conditional rendering) shows/hides the text, and
 * saveStatusStyle's fixed min-width — sized to the longest of "saving…" /
 * "saved" / "error" — reserves the space so nothing moves by even 1px
 * when the text appears/disappears. Same "always mounted, out of flow"
 * idea as V-T48's Refreshing… fix on the macro-codes page — that one used
 * position:absolute since its indicator floats over the whole page; this
 * one uses a reserved-width inline element since it sits beside a
 * table-cell input where an absolutely positioned sibling would overlap
 * neighboring cells/columns. Also used for the Walk-up % field's own
 * saving/saved/error indicator in page.tsx, for the same reason.
 */

export type SaveStatus = "idle" | "saving" | "saved" | "error";

// inline-block + nowrap keep this width from collapsing or wrapping onto a
// second line (which would change row height instead of column width).
export const saveStatusStyle: CSSProperties = {
  fontSize: "0.7rem",
  marginLeft: "0.35rem",
  display: "inline-block",
  minWidth: "8ch",
  whiteSpace: "nowrap",
};

const targetInputStyle: CSSProperties = {
  width: 64,
  padding: "1px 4px",
  boxSizing: "border-box",
  border: "1px solid #bbb",
  fontSize: "13px",
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

export function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  return (
    <span
      style={{
        ...saveStatusStyle,
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
    <span>
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
      <SaveStatusIndicator status={status} />
    </span>
  );
}
