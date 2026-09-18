import type { MacroDoseButton, MacroRow } from "@/lib/macro-codes";
import type { MacroSection } from "@/lib/macro-catalog";

/**
 * Shared copy-to-clipboard macro dose BUTTON — extracted out of
 * app/macro-codes/page.tsx (round 4-10's `renderDoseButton`/
 * `SECTION_COLORS`/`copyToClipboard`/`CopyFallback`/`missingNote`, all
 * byte-identical below, just parameterized instead of closing over that
 * page's own React state) so a second page can render the exact same
 * look/behavior without re-implementing it.
 *
 * First consumer: app/screener/page.tsx (V-screener-by-type, coordinator
 * brief 2026-09-13, quoting Will verbatim: "I also asked for
 * reformatting of this section to be based on the vaccine type instead
 * of product name, with the products listed as our macro code buttons
 * that can copy/paste") — the screener now fetches the same
 * vaccines+lots data as /macro-codes and renders each eligible
 * product's real dose buttons via `renderMacroDoseButton` below, grouped
 * by vaccine type instead of by product/status. app/macro-codes/page.tsx
 * itself was updated to call this same function instead of its own
 * local copy, so the two pages can never visually drift apart again.
 *
 * State ownership stays with the CALLING page (copiedKey, copyFailure,
 * any lot/exp modal) — this module only owns the parts that never need
 * page-specific state: the color palette, the "Copied ✓" sizing
 * constants, the clipboard helper, the manual-copy fallback UI, the
 * missing-lot/exp note, the row key, and the button's own JSX/styling.
 */

export type SectionColors = { bg: string; border: string; text: string };

/** One hue per section (Will's brief: "Colors: one hue per SECTION...
 * readable text, subtle (light background + darker border/text)").
 * Every MacroSection has an explicit entry so the palette is fully
 * deterministic — no runtime hashing/cycling logic to get wrong. */
export const SECTION_COLORS: Readonly<Record<MacroSection, SectionColors>> = {
  Flu: { bg: "#e8f1fd", border: "#7fa8dd", text: "#1a4c8f" },
  COVID: { bg: "#f2ebfa", border: "#a67fd6", text: "#5a2d92" },
  Pneumonia: { bg: "#fdf1e3", border: "#e0a55e", text: "#8f5a17" },
  RSV: { bg: "#e5f7f4", border: "#5cc0b3", text: "#136a5e" },
  Shingles: { bg: "#fdecec", border: "#e07a7a", text: "#8f1f1f" },
  "Hep B": { bg: "#eaf7e8", border: "#7bc069", text: "#2d6b1e" },
  Tetanus: { bg: "#eceffb", border: "#8d97d4", text: "#32389b" },
  HPV: { bg: "#fbeaf3", border: "#d97fb0", text: "#96285f" },
  Meningitis: { bg: "#e7f6fb", border: "#63b6d5", text: "#155e78" },
  "Hep A": { bg: "#f3f0e6", border: "#b7a468", text: "#6b5a1c" },
  Typhoid: { bg: "#eef3f5", border: "#8ea6af", text: "#33505c" },
  MMR: { bg: "#f6ece6", border: "#c98f68", text: "#7a4419" },
  Other: { bg: "#f2f2f2", border: "#aaaaaa", text: "#4d4d4d" },
};

/** V-T50 (Will's verbatim feedback, 2026-09-18): "I would like the flu
 * shots to be different colors on their buttons to easily tell them
 * apart. Flucelvax is light green, Fluad light blue, FluMist gray,
 * mFLUSIVA light red." Keyed by MacroCatalogEntry.colorKey (lib/
 * macro-catalog.ts) — flucelvaxmdv AND flucelvaxpfs both resolve to the
 * "flucelvax" key so both short codes get the same color. Fluad has no
 * entry here on purpose: Will's ask for Fluad is "light blue," which is
 * already SECTION_COLORS.Flu's own hue, so it just falls through to that
 * (see resolveDoseButtonColors below) rather than duplicating it. Every
 * OTHER flu product (Afluria, Fluzone, Flublok) also falls through to
 * SECTION_COLORS.Flu, unchanged. */
export const PRODUCT_COLORS: Readonly<Record<string, SectionColors>> = {
  flucelvax: { bg: "#e6f8ec", border: "#6cc084", text: "#1c6b35" },
  flumist: { bg: "#ececec", border: "#9a9a9a", text: "#3f3f3f" },
  mflusiva: { bg: "#fdecea", border: "#e2867e", text: "#8f2a20" },
};

/** Resolves a dose button's colors: a per-product PRODUCT_COLORS override
 * when its resolved macro-catalog colorKey has one, else the row's
 * section color. Exported for its own unit test coverage. */
export function resolveDoseButtonColors(row: Pick<MacroRow, "section" | "colorKey">): SectionColors {
  return PRODUCT_COLORS[row.colorKey] ?? SECTION_COLORS[row.section];
}

/** "Copied ✓" is 8 characters — a button's reserved width is at least
 * that (plus a little breathing room) so swapping the label to the
 * copied flag never shifts layout, per Will's brief ("'Copied ✓'
 * feedback on the button for 1.5s without layout shift"). */
export const COPIED_FLAG = "Copied ✓";
export const MIN_BUTTON_CH = COPIED_FLAG.length + 1;

/** Copies text via the Clipboard API, falling back to a hidden
 * textarea + execCommand for non-secure (http, non-localhost) contexts
 * where navigator.clipboard is unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback below
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

const copyFallbackStyles = {
  wrap: { margin: "0.15rem 0 0.4rem", width: "100%" } as const,
  error: { color: "#b00020", fontSize: "0.72rem" } as const,
  input: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.8rem",
    width: "100%",
    padding: "2px 4px",
    boxSizing: "border-box" as const,
    border: "1px solid #b00020",
  },
};

/** Read-only, auto-selected text field shown when copyToClipboard
 * returns false — the code is still visible/selectable so a manual
 * Cmd/Ctrl+C still works even though the programmatic copy didn't. */
export function CopyFallback({ code }: { code: string }) {
  return (
    <p style={copyFallbackStyles.wrap}>
      <span style={copyFallbackStyles.error}>Couldn&apos;t copy — select and copy manually:</span>
      <br />
      <input
        type="text"
        readOnly
        autoFocus
        value={code}
        style={copyFallbackStyles.input}
        onFocus={(e) => e.currentTarget.select()}
      />
    </p>
  );
}

/** Stable per-dose-row key, used both as a React key and to correlate a
 * row with the calling page's copiedKey/copyFailure state. */
export function macroRowKey(row: MacroRow): string {
  return `${row.productKey}:${row.doseNumber}`;
}

export function missingNote(row: MacroRow): string | null {
  if (row.complete || row.shortCode === null) return null;
  const missingLot = !row.lotNumber;
  const missingExp = !row.expirationIso;
  if (missingLot && missingExp) return "lot + exp missing";
  if (missingLot) return "lot missing";
  if (missingExp) return "exp missing";
  return null;
}

export interface RenderMacroDoseButtonOptions {
  /** ROUND 14 (V-T48, Will's verbatim brief, 2026-09-16): "Add the
   * vaccine name to the buttons as well. The vaccine name is row 1,
   * Dose is row 2, then row 3 is the scheduling dates for some of the
   * vaccines." An optional new FIRST line, shown above `visibleLabel`/
   * `label` — /macro-codes' renderSectionVersionC (this module's only
   * current caller) passes the product's displayName here; omitted
   * entirely (no layout change at all) when a caller doesn't pass it. */
  topLabel?: string;
  /** Shown instead of the full `dose.label` (e.g. version B/C's short
   * "Dose 1"/"One dose" — lib/macro-codes.ts's doseButtonShortLabel)
   * while the click/copy/tooltip still use the full descriptive label. */
  visibleLabel?: string;
  /** An optional second, tiny/muted line — the per-dose schedule
   * interval (MacroRow.doseInterval, e.g. "2 mo" under a "Dose 2"
   * button). Hidden while showing "Copied ✓". */
  subLabel?: string;
  /** Version A's one-per-line vertical stack — full width, left-aligned
   * text, instead of an inline pill sized to its label. */
  block?: boolean;
  /** Version C's bigger hit target. */
  large?: boolean;
  /** ROUND 11 (Will's verbatim feedback on /macro-codes, 2026-09-13:
   * "The buttons still aren't lining up pretty, I think mostly because
   * dose 1 doesn't have a date on it, so you need to adjust for that to
   * make sure the heights all match"). When true, the second (interval)
   * line's height is reserved even for a dose with no `subLabel` of its
   * own (an empty, `visibility: hidden` placeholder line) — the CALLER
   * decides this per PRODUCT (true whenever any sibling dose in the same
   * product has an interval), so every dose button of that product is
   * the same height regardless of which individual doses carry a
   * schedule note. */
  reserveSubLabelSlot?: boolean;
  /** ROUND 11 (Will's verbatim feedback: "I want all the buttons to fit
   * on one row, so if there are 3 doses, they all need to fit"). Makes
   * the button flex to fill an equal share of its row (flex: 1 1 0,
   * minWidth: 0) instead of sizing to its own label's content, and lets
   * `doseCountInRow` shrink its text/padding — the CALLER's flex
   * container must also be `flex-wrap: nowrap` for this to actually keep
   * every dose on one line (see .macro-dose-buttons-c in
   * app/macro-codes/page.tsx). Off by default — versions A/B keep their
   * original wrap-if-needed sizing. */
  fitRow?: boolean;
  /** How many dose buttons share this product's row. ROUND 12 (Will's
   * verbatim feedback, 2026-09-13, on top of the round-11 fitRow work
   * above): "I want the dose 1/2/3 font size to be the same as the other
   * buttons so they look the same. If we need to increase width of the
   * table we can do that." A 3+ dose fitRow group used to shrink its
   * font/padding to squeeze onto one line (the round-11 "crowded" knob)
   * — that's gone; every dose button now renders at the SAME font size/
   * padding regardless of doseCountInRow, and the caller widens its
   * column instead (see app/macro-codes/page.tsx's renderTopGroup — the
   * layout-C column basis/min-width and .macro-groups-c's max-width both
   * grew to fit three full-size buttons on one row). This prop is kept
   * (rather than removed) only because callers already compute and pass
   * it; it's accepted but no longer changes any style. */
  doseCountInRow?: number;
}

/** ROUND 12 (Will's verbatim feedback, 2026-09-13, on /macro-codes:
 * Gardasil 9's Dose 2 sub-label "–2 mo · 9–…" and M-M-R II's Dose 2
 * "28 d · special g…" were both cut off with an ellipsis). The interval
 * sub-label now wraps onto up to two short lines instead of clipping to
 * one — `-webkit-line-clamp: 2` still ellipsizes anything past that, but
 * a two-clause interval like "1–2 mo · 9–14: 6 mo" or "28 d · special
 * groups" fits comfortably across two lines at the SAME font size used
 * everywhere else (no more per-crowding shrink — see doseCountInRow's
 * doc comment above). Height for this slot is a fixed reservation (not
 * content-driven) sized for exactly two lines at this font, applied
 * identically to every dose button in a product's row — including the
 * ones with no interval of their own (reserveSubLabelSlot's blank
 * placeholder line) — so a product with one two-line interval and one
 * empty slot still lines up at the same height, the same guarantee
 * round 11 made for one line, now extended to two. */
// Exported (not just module-local) so this pure sizing math is plain-
// vitest testable on its own, same posture as this file's other exports
// — see tests/macro-dose-button.test.ts.
export function subLabelFontSizePx(compact: boolean, large: boolean): number {
  return compact ? 9 : large ? 11 : 10;
}
export const SUB_LABEL_LINE_HEIGHT = 1.15;
export function subLabelSlotHeightPx(compact: boolean, large: boolean): number {
  return Math.ceil(subLabelFontSizePx(compact, large) * SUB_LABEL_LINE_HEIGHT * 2);
}

/**
 * Renders one copy-to-clipboard dose button, byte-identical to
 * app/macro-codes/page.tsx's round-10 `renderDoseButton` — same sizing,
 * colors, "Copied ✓" swap, missing-lot/exp red dot, and copy-failure
 * fallback — just taking the calling page's state (`isCopied`,
 * `copyFailureCode`) and click handler (`onClick`) as parameters instead
 * of closing over page-local React state. `compact` is the same knob
 * app/macro-codes/page.tsx's embed mode used (tighter sizing for a
 * small popup); pass false/omit for a normal full-page look.
 */
export function renderMacroDoseButton(
  dose: MacroDoseButton,
  colors: SectionColors,
  params: {
    isCopied: boolean;
    copyFailureCode?: string | null;
    onClick: () => void;
    compact?: boolean;
  } & RenderMacroDoseButtonOptions
) {
  const { row, label } = dose;
  const key = macroRowKey(row);
  const isNoShortCode = row.shortCode === null;
  const {
    isCopied,
    copyFailureCode,
    onClick,
    compact = false,
    block = false,
    large = false,
    fitRow = false,
    reserveSubLabelSlot = false,
    doseCountInRow = 1,
    topLabel,
  } = params;
  const visibleText = isCopied ? COPIED_FLAG : params.visibleLabel ?? label;
  const note = missingNote(row);
  // Hidden while showing "Copied ✓" — that flag already says everything
  // the button needs to say for that 1.5s.
  const subLabel = !isCopied ? params.subLabel : undefined;
  const defaultTitle = subLabel ? `Copy ${label} macro code — ${subLabel}` : `Copy ${label} macro code`;
  // ROUND 11: a product's dose buttons must all be the same height even
  // when only SOME of them carry a schedule interval (e.g. dose 1 never
  // has one) — the caller says so per-product via reserveSubLabelSlot,
  // and this dose gets an empty, invisible placeholder line instead of
  // just being one line shorter than its siblings.
  const showSubLabelSlot = Boolean(subLabel) || reserveSubLabelSlot;
  // ROUND 14: `topLabel` (the vaccine name, row 1) is hidden while
  // showing "Copied ✓" too — same posture as subLabel above, and for the
  // same reason (the flag already says everything needed for that 1.5s).
  const showTopLabel = Boolean(topLabel) && !isCopied;
  // ROUND 12: doseCountInRow no longer changes sizing (see its doc
  // comment) — accepted for API compatibility with existing callers only.
  void doseCountInRow;
  const subLabelFontSize = subLabelFontSizePx(compact, large);
  // Main-label line height at this button's own font size, used only to
  // size the fixed two-line sub-label reservation below relative to it —
  // not applied anywhere else (the button's overall height still comes
  // from `minHeight` + natural content flow, same as before round 12).
  const mainLineHeight = Math.round((compact ? 11 : large ? 13 : 12) * 1.2);
  const subLabelSlotHeight = subLabelSlotHeightPx(compact, large);
  // ROUND 14 (V-T48): one extra single line, reserved only when a
  // `topLabel` is actually shown — the button's minHeight below grows by
  // exactly this much and nothing else, per Will's brief ("grow it the
  // minimum needed and keep the grid the same otherwise").
  const topLabelLineHeight = Math.ceil(subLabelFontSize * SUB_LABEL_LINE_HEIGHT);

  return (
    <span
      key={key}
      style={{
        position: "relative",
        display: fitRow ? "inline-flex" : block ? "block" : "inline-block",
        width: block ? "100%" : undefined,
        // A button must never be squeezed narrower than its own content
        // inside a flex-wrap button group — the GROUP wraps to a new
        // line instead. `fitRow` inverts this on purpose: the button
        // FLEXES to share the row instead, so three can fit on one line.
        flex: fitRow ? "1 1 0" : undefined,
        minWidth: fitRow ? 0 : undefined,
        flexShrink: fitRow ? undefined : block ? undefined : 0,
      }}
    >
      <button
        type="button"
        disabled={isNoShortCode}
        onClick={onClick}
        title={isNoShortCode ? "no short code set" : note ? note : defaultTitle}
        className="macro-dose-button"
        style={{
          border: `1px solid ${isNoShortCode ? "#ccc" : colors.border}`,
          background: isNoShortCode ? "#f2f2f2" : colors.bg,
          color: isNoShortCode ? "#888" : colors.text,
          borderRadius: 5,
          // ROUND 12: the sub-label slot now always reserves TWO lines
          // (subLabelSlotHeight), not one — including in `compact` (embed)
          // mode, which previously hard-coded 28px regardless of
          // showSubLabelSlot (a pre-existing gap this fix closes rather
          // than carries forward, since a two-line reservation inside a
          // still-28px-tall button would visibly overflow/clip).
          // ROUND 14: `topLabel`'s single reserved line (topLabelLineHeight
          // + a 1px gap, matching the gap already used between the other
          // stacked lines) is added on top of whichever base height above
          // already applied — the only height change this round makes.
          minHeight:
            (showSubLabelSlot ? mainLineHeight + 1 + subLabelSlotHeight + 8 : compact ? 28 : large ? 38 : 32) +
            (showTopLabel ? topLabelLineHeight + 1 : 0),
          padding: compact ? "0 0.5rem" : large ? "0 0.75rem" : "0 0.5rem",
          display: "inline-flex",
          flexDirection: showSubLabelSlot || showTopLabel ? "column" : "row",
          alignItems: showSubLabelSlot || showTopLabel ? (block ? "flex-start" : "center") : "center",
          justifyContent: showSubLabelSlot || showTopLabel ? "center" : block ? "flex-start" : "center",
          gap: showSubLabelSlot || showTopLabel ? 1 : undefined,
          fontSize: compact ? "11px" : large ? "13px" : "12px",
          fontWeight: 600,
          whiteSpace: fitRow ? undefined : "nowrap",
          cursor: isNoShortCode ? "default" : "pointer",
          width: block || fitRow ? "100%" : undefined,
          minWidth: block || fitRow ? undefined : `${Math.max(visibleText.length, MIN_BUTTON_CH)}ch`,
          textAlign: block ? "left" : "center",
          boxSizing: "border-box",
          overflow: fitRow ? "hidden" : undefined,
        }}
      >
        {showTopLabel && (
          <span
            style={{
              display: "block",
              width: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: `${subLabelFontSize}px`,
              fontWeight: 700,
              lineHeight: `${topLabelLineHeight}px`,
            }}
          >
            {topLabel}
          </span>
        )}
        <span
          style={
            fitRow
              ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }
              : undefined
          }
        >
          {visibleText}
        </span>
        {showSubLabelSlot && (
          <span
            aria-hidden="true"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              height: subLabelSlotHeight,
              lineHeight: `${SUB_LABEL_LINE_HEIGHT}em`,
              maxWidth: compact ? 96 : large ? 130 : 112,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "normal",
              wordBreak: "break-word",
              fontSize: `${subLabelFontSize}px`,
              fontWeight: 400,
              color: isNoShortCode ? "#999" : "#666",
              visibility: subLabel ? "visible" : "hidden",
            }}
          >
            {subLabel ?? "\u00a0"}
          </span>
        )}
      </button>
      {!isNoShortCode && note && (
        <span
          aria-hidden="true"
          title={note}
          style={{
            position: "absolute",
            top: -2,
            right: -2,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#c62828",
            border: "1px solid #fff",
          }}
        />
      )}
      {copyFailureCode && <CopyFallback code={copyFailureCode} />}
    </span>
  );
}
