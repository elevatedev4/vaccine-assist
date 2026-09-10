"use client";

import { useEffect, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties } from "react";
import { digitsToIso, isoToMaskedDate, maskDateInput, normalizePastedDateText, onlyDigits } from "@/lib/date-mask";

/**
 * Typed MM/DD/YYYY date field — replaces every native
 * `<input type="date">` on /lots (Will, 2026-09-09 4:29pm, verbatim:
 * "make it something you can type the whole thing at once and it will
 * automatically add/remove the '/' at the right time, as opposed to
 * being a date picker field where you can edit MONTH then click into
 * DAY, etc. ... we'll never use a date picker"). Auto-inserts "/" as
 * digits are typed/removed (lib/date-mask.ts's maskDateInput); a paste
 * of "09/16/2028", "9/16/28", or "20280916" all normalize to the same
 * masked display (normalizePastedDateText). Stores/reports the value as
 * "YYYY-MM-DD" — the same ISO shape the previous type="date" inputs
 * already produced, so every caller's draft state is unchanged.
 *
 * `onChange` fires on every keystroke with the current ISO value, or ""
 * while the field is empty/incomplete/invalid — callers that require a
 * complete date (e.g. the /lots autosave gate) already guard on a falsy
 * value the same way they did for the old type="date" input. A red
 * border (and aria-invalid) shows once the field has 8 digits typed but
 * they don't form a real calendar date (e.g. "02/30/2026") — Will's
 * brief: "invalid dates show a red border and don't save."
 *
 * `onRawTextChange` (V-T-ordering-lots-round4, optional, additive) fires
 * alongside `onChange` with the field's raw masked "MM/DD/YYYY"-in-
 * progress display text, NOT collapsed to "" for an incomplete/invalid
 * date the way `onChange`'s ISO value is — the /lots autosave wiring
 * needs this raw text to distinguish "still typing" from "8 digits but
 * not a real date" via lib/lots-autosave.ts's decideDateAutosave, which
 * `onChange` alone can't tell apart (both collapse to "").
 *
 * `onBlur` (optional, additive) fires on the underlying input's blur —
 * used by /lots' autosave to flush a pending debounced save immediately
 * when the field loses focus, same as every other autosaving field there.
 */
export default function DateTextInput({
  value,
  onChange,
  onRawTextChange,
  onBlur,
  ariaLabel,
  disabled,
  style,
}: {
  value: string;
  onChange: (isoOrEmpty: string) => void;
  onRawTextChange?: (text: string) => void;
  onBlur?: () => void;
  ariaLabel?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [text, setText] = useState(() => isoToMaskedDate(value));

  useEffect(() => {
    setText(isoToMaskedDate(value));
  }, [value]);

  function commit(nextText: string) {
    setText(nextText);
    onRawTextChange?.(nextText);
    const digits = onlyDigits(nextText);
    if (digits.length === 0) {
      onChange("");
      return;
    }
    onChange(digitsToIso(digits) ?? "");
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    commit(maskDateInput(e.target.value));
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    commit(normalizePastedDateText(e.clipboardData.getData("text")));
  }

  const digits = onlyDigits(text);
  const invalid = digits.length === 8 && digitsToIso(digits) === null;

  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder="MM/DD/YYYY"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      disabled={disabled}
      value={text}
      onChange={handleChange}
      onPaste={handlePaste}
      onBlur={onBlur}
      style={{ ...style, borderColor: invalid ? "#b00020" : style?.borderColor }}
    />
  );
}
