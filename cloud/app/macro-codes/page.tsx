"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import {
  buildMacroCode,
  buildMacroRows,
  doseButtonShortLabel,
  filterMacroProductsByAge,
  filterMacroTopGroups,
  groupMacroRowsBySection,
  groupSectionsByTopGroup,
  macroProductDisplayLabel,
  macroSectionDisplayName,
  type MacroDoseButton,
  type MacroLotLike,
  type MacroProductGroup,
  type MacroRow,
  type MacroRowVaccine,
  type MacroSection,
  type MacroSectionGroup,
  type MacroTopGroupBlock,
} from "@/lib/macro-codes";
import { formatNdcDisplay } from "@/lib/lots-grouping";
import { postToHost, postContentSize } from "@/lib/macro-embed";
import {
  fetchMacroCodesPayload,
  getMacroCodesCacheStorage,
  readMacroCodesCache,
  writeMacroCodesCache,
  clearMacroCodesCache,
} from "@/lib/macro-codes-cache";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";
import {
  CopyFallback,
  SECTION_COLORS,
  copyToClipboard,
  macroRowKey,
  missingNote,
  renderMacroDoseButton,
  resolveDoseButtonColors,
  type SectionColors,
} from "@/lib/macro-dose-button";

/**
 * /macro-codes tab, round 6 (Will's verbatim feedback, 2026-09-12,
 * replying to the round-5 page): "'COVID/Flu' group. Pneumonia, RSV,
 * Shingles, Tdap, HPV should go in the middle under 'Common', then all
 * others under 'Other'. Ages go in parenthesis. Just put 'Engerix-B
 * adult' for the name. I think the dose needs to say '(Dose X)' after
 * the product name."
 *
 * Sections (Flu, COVID, RSV, Shingles, ...) now layer into three
 * top-level groups — "COVID/Flu", "Common", "Other" — rendered as three
 * columns (see .macro-groups / .macro-group-column in the <style> tag),
 * each column stacking its member sections top to bottom; the grouping
 * itself is lib/macro-codes.ts's groupSectionsByTopGroup /
 * lib/macro-catalog.ts's topGroupForSection. Dose button labels are
 * "<name> (Dose N) (<age>)" (lib/macro-codes.ts's doseButtonLabel) —
 * dose only for multi-dose products, age only when the row has one, an
 * age that already carries its own parenthetical flattened to a comma
 * clause so a label never nests parens two deep. Engerix-B's name is
 * "Engerix-B adult" on this page only (see macro-codes.ts's
 * MACRO_DISPLAY_NAME_OVERRIDES). Everything else from round 5 is
 * unchanged: one small inline ⚙ disclosure per product (covering every
 * dose), cash price hidden (data/plumbing kept, just not rendered — see
 * formatCashPrice's call site below), click-to-copy / lot-exp modal
 * logic from round 3. Names come pre-cleaned from
 * lib/product-view.ts's buildProductViews; pure row-building/grouping
 * logic lives in lib/macro-codes.ts / lib/macro-catalog.ts (both unit-
 * tested).
 *
 * ROUND 8 (Will's verbatim feedback, 2026-09-12, replying to the round-7
 * page): "I don't like the layout where you have a heading then next
 * row the buttons. Instead, have the heading be in 1 column, then the
 * buttons next to it stacked vertically... I want to see two versions
 * as well: one that has another column after type (ex: tdap), then
 * product (ex Boostrix (with age range)) > Dose 1 button... If you have
 * any other ideas to make this user friendly... feel free to research
 * the best way and make another version." Adds a three-way layout
 * switcher (renderSectionVersionA/B/C below), all built on the SAME
 * topGroups data (buildMacroRows -> groupMacroRowsBySection ->
 * groupSectionsByTopGroup, unchanged) — only the render layer varies:
 *
 * - Version A: one row per section/family — a fixed-width family-name
 *   cell (macroSectionDisplayName, e.g. "Tdap" for Tetanus) next to a
 *   vertical stack of every dose button in that family, one per line,
 *   full label text unchanged from round 7.
 * - Version B: one row per product, three columns — family name |
 *   plain-text product name + age (macroProductNameWithAge) | short
 *   dose buttons ("Dose 1"/"Dose 2", or "One dose" for a single-dose
 *   product — see lib/macro-codes.ts's doseButtonShortLabel).
 * - Version C: a from-scratch "scan grid" — see its own comment at
 *   renderSectionVersionC for the design rationale.
 *
 * The switcher's choice persists in localStorage (read/write wrapped in
 * try/catch, factored into lib/macro-codes.ts's
 * readMacroViewMode/writeMacroViewMode so it's unit-testable without a
 * DOM) and defaults to "A". Copy behavior, the lot/exp modal, the ⚙
 * menu, and hidden prices are IDENTICAL across all three versions —
 * renderDoseButton and renderSettingsMenu are shared, just parameterized
 * by a visible-label override and a couple of layout flags; nothing
 * about handleCopy/copyToClipboard/the modal is duplicated per version.
 *
 * ROUND 9 (Will's verbatim feedback, 2026-09-13, replying to round 8):
 * "I like C so far, but keep all the options for now. Let's work on
 * improving C." Polishes version C ONLY (A and B are byte-for-byte
 * unchanged) — see renderSectionVersionC's own doc comment for the
 * per-item breakdown (bold product name, smaller gray age/price line,
 * ⓘ special-qualification tooltip, and a capped/content-sized column
 * width instead of the old edge-to-edge stretch).
 *
 * EMBED MODE (V-macro-codes-round9, Will verbatim, 2026-09-13): "Make a
 * macro code popup in the vaccine assist app that pops up this screen
 * we built when someone pushes Ctrl+8. When they click on the one they
 * want, it copies the macro code and closes the page so they can go
 * resume data entry themselves." The desktop (WPF) half — built in
 * parallel, not part of this file — opens `/macro-codes?embed=1` in its
 * own popup/WebView2 host on Ctrl+8; `embed` (read via useSearchParams,
 * which is why the default export below wraps the real component in a
 * <Suspense> boundary — required by Next for any component that calls
 * it) drives a handful of presentation-only differences, all gated on
 * that one boolean: no top nav (hidden via a global CSS rule this page
 * injects targeting top-nav.tsx's `data-top-nav` hook — TopNav itself
 * is untouched), no page title/switcher, `effectiveViewMode` forces
 * layout C for rendering while leaving the real `viewMode` state (and
 * its localStorage read/write) completely alone so a later non-embed
 * visit still sees whatever the user had chosen before, tighter page
 * padding, a white body background, and the version-C filter box
 * auto-focused. None of buildMacroRows/groupMacroRowsBySection/
 * groupSectionsByTopGroup/the catalog data change — embed mode is
 * output-layer only. Copy behavior gains one more step in embed mode:
 * after a successful clipboard copy (both the direct-copy path for a
 * complete row and the lot/exp-modal path for an incomplete one), it
 * posts a `vaccine-assist:macro-copied` message via lib/macro-embed.ts's
 * postToHost and calls `window.close()`; Escape (when neither the modal
 * nor a ⚙ menu is open — those already own Escape for their own
 * cancel/close) posts `vaccine-assist:macro-cancel` and closes the same
 * way. A copy FAILURE (clipboard denied) does not post/close — the
 * existing manual-copy fallback UI shows instead, same as non-embed.
 *
 * ROUND 10 (Will's verbatim feedback, 2026-09-13): "Change 'Copy' to
 * 'One dose.' Add one tiny deemphasized line on the buttons for 1-3
 * dose items that includes the schedule for when to get those doses."
 * Both changes live in version B/C's short dose-button label/subLabel
 * (embed reuses C, so it inherits both automatically) — version A is
 * left alone: its buttons already carry a full descriptive label
 * ("Shingrix (Dose 2) (50+, 19+ IC)") with no separate short-label
 * column next to them the way B/C have, so appending a second clause
 * with Gardasil/MMR's multi-part schedule text there read as clutter on
 * an already-dense label rather than a helpful addition; the doseSchedule
 * data itself is still computed for every version (lib/macro-codes.ts's
 * MacroRow.doseInterval), just not rendered by renderSectionVersionA.
 * doseButtonShortLabel moved to lib/macro-codes.ts (was local to this
 * file) so both the "One dose" label and the interval piping are
 * unit-tested there rather than only exercised by hand in the browser.
 *
 * ROUND 12 — INSTANT LOAD (Will's verbatim brief, 2026-09-13): "Macro
 * codes take way too long to load. It needs to be instant... You should
 * preload the info when the app is first loaded so it will start fast,
 * and then of course make sure that it stays up to date all the time
 * when data changes." lib/macro-codes-cache.ts holds a localStorage
 * cache of the last successful /api/vaccines + /api/lots payload, keyed
 * per signed-in user. Stale-while-revalidate: on mount, a cached payload
 * (if any) is applied to `vaccines`/`lots` IMMEDIATELY — before any
 * network call — so this page never shows "Loading…" when a cache
 * exists; a background refetch (loadAll's `background: true` path) then
 * follows and silently replaces it if the server data changed.
 * `revalidating`/`refreshNote` track that background fetch separately
 * from `loading` (which now only means "nothing to show yet, on screen
 * or cached") so the page keeps rendering the cached view underneath a
 * small note rather than blanking back to a spinner.
 *
 * Freshness, per the brief ("stays up to date all the time"): a
 * background revalidation additionally fires on window focus, on
 * document visibilitychange back to visible, on a ~60s interval while
 * the tab is visible, and right after a lot/exp save in the modal below
 * (handleModalSubmit's refetchLots call) — a mutation the user just made
 * must never wait up to 60s to show up. A failed background refetch
 * (offline, 5xx) leaves the existing view up and sets `refreshNote`
 * rather than clearing anything. A 401/expired token is called out
 * specifically (`unauthorized` on fetchMacroCodesPayload's result): the
 * brief's own words are "a 401/expired token never renders stale data
 * silently" — this page never treats that response as fresh data, and
 * refreshNote reads "Session expired…" instead of the generic "Could not
 * refresh…" so it's clear the cached view is now UNVERIFIED, not merely
 * a network hiccup.
 *
 * Prefetch: app/top-nav.tsx — rendered on every route, not just this
 * page — warms the exact same cache (same fetchMacroCodesPayload call,
 * same per-email key) as soon as a session appears, so a visit to
 * /macro-codes after using any other tab is already warm. The desktop
 * app's popup (?embed=1) is the SAME origin as every other route here,
 * so it shares this same localStorage cache automatically — no separate
 * embed-specific caching was needed.
 *
 * ROUND 14 (V-T48, Will's verbatim brief): "Make C the default view.
 * Delete the other views. Add the vaccine name to the buttons as well.
 * The vaccine name is row 1, Dose is row 2, then row 3 is the
 * scheduling dates for some of the vaccines." Version C (the round-9+
 * "scan grid") is now the page's ONLY layout: renderSectionVersionA/B,
 * the round-8 switcher UI, VIEW_MODE_OPTIONS, and the version-B-only
 * macroProductNameWithAge call are all deleted — not hidden behind a
 * flag. So a stale localStorage choice can never select a removed
 * layout, the round-8 persisted preference (lib/macro-codes.ts's
 * readMacroViewMode/writeMacroViewMode/MacroViewMode/
 * MacroViewModeStorage) is deleted too, replaced by
 * lib/macro-codes.ts's MACRO_VIEW_MODE constant — a pure "C" literal a
 * test can assert without touching React/DOM. `effectiveViewMode` is
 * gone along with it: embed mode no longer needs to "force" layout C
 * since C is the only layout there is. C's own rendering/CSS is
 * otherwise byte-for-byte unchanged from round 13 except for the name
 * row: renderDoseButton/renderMacroDoseButton (lib/macro-dose-button.tsx)
 * grow an optional `topLabel` (the product's displayName) rendered as a
 * new first line above the existing dose-label line, with the existing
 * schedule-interval sub-label line staying third when a dose has one —
 * sizes/colors/order/grouping/hotkeys/instant-copy are all untouched;
 * only the button's minHeight grows the minimum needed to fit the name
 * line.
 *
 * ROUND 15 (Will's verbatim ask, 2026-09-24, follow-up to the maker-name
 * feature): "vaccine macro codes: follow up to brand covnetion. Make it
 * look liek this: Pfizer 12+ (Comirnaty 2026-27)." Every bare
 * product-name render site on this page (the product-name row, a dose
 * button's `topLabel`, the ⚙ menu's aria-label, the lot/exp modal
 * heading, and the postToHost `product` field) swaps its direct
 * `vaccineDisplayName(...)` call for lib/macro-codes.ts's new
 * macroProductDisplayLabel(displayName, age) — a COVID product now
 * reads "Pfizer 12+ (Comirnaty 2026-27)" everywhere instead of the
 * bare maker-prefixed name; a non-COVID product's name is byte-for-byte
 * unchanged (macroProductDisplayLabel falls back to vaccineDisplayName,
 * a no-op for it). Dose button LABELS (doseButtonLabel, `dose.label`,
 * used for the button's own visible text and the postToHost `label`
 * field) get the same new composite from lib/macro-codes.ts directly —
 * see that file's own ROUND 15 note.
 *
 * MACRO-POPUP ROUND 3 (Will's verbatim ask, 2026-09-25, on the Ctrl+8/
 * Ctrl+Numpad2 popup, after round 2 just made the WPF window itself
 * bigger): "The macro codes page looks silly. Make it wider so that it
 * will display bigger, and make the height fit only what it needs to
 * be able to show everything, not extra space at the bottom." EMBED
 * MODE ONLY, same posture as every other embed-only change above — the
 * normal, non-embed page is untouched:
 * - Width: the grid's own `maxWidth` was already `"100%"` for embed
 *   (see the .macro-groups-c wrapper's inline style below), so the fix
 *   here is the type scale, not a width cap — dose buttons/product
 *   names/dose labels are now ~20-25% bigger in embed than they were
 *   (lib/macro-dose-button.tsx's mainLabelFontSizePx/
 *   buttonBaseMinHeightPx/buttonPaddingRem/subLabelFontSizePx/
 *   subLabelMaxWidthPx — see that file's own round-3 note for why
 *   `compact` used to render SMALLER than the normal page despite embed
 *   always passing `large: true` too), plus this page's own embed-only
 *   band/name/meta/age-filter-note sizes below. Side padding on `<main>`
 *   grew from a cramped 8px to a comfortable 24px; the old "EMBED
 *   COMPACT" 980x760 height-budget arithmetic (this file's <style> tag)
 *   is retired along with the fixed-target-height assumption it was
 *   written for — see the next bullet.
 * - Height: this page no longer tries to fit a fixed guessed window
 *   size at all. It reports its own rendered size to the desktop host —
 *   lib/macro-embed.ts's postContentSize(width, height) — once after
 *   first paint and again on every subsequent size change (a
 *   ResizeObserver on `<main>` itself, debounced ~50ms) below, and
 *   MacroCodesWindow.xaml.cs resizes the actual WPF window to match
 *   (see that file's own round-3 note). The measurement target is
 *   `<main>` (embedContentEl, set via a callback ref), NOT
 *   `document.documentElement` — the root element's scrollHeight is
 *   `max(viewport height, content height)` per the CSSOM View spec, so
 *   once the WebView2 viewport was ever as tall as the window's current
 *   height, it could never report SHORTER again: the window would grow
 *   for a long list but never shrink back for a short filtered one,
 *   which is exactly the "extra space at the bottom" the brief called
 *   out. `<main>`'s own getBoundingClientRect() has no such floor. This
 *   file's embed-only global CSS rule also zeroes `body`'s default ~8px
 *   margin, so nothing outside `<main>`'s own measured box adds
 *   unaccounted-for height — and drops `overflow: hidden` on `body`
 *   entirely: the window can still end up shorter than the content on a
 *   small monitor (clamped to the work area), and when it does the
 *   WebView2 control needs to scroll internally rather than clip.
 */

type VaccineRow = MacroRowVaccine;
// expiration is nullable since V-lots-clear-save follow-up
// (supabase/migrations/0014_...) — buildMacroRows/buildMacroCode
// already tolerate this via `currentLot?.expiration ?? null`.
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string | null; status: string };

const styles = {
  // `position: relative` so refreshIndicator (below) can anchor to this
  // box instead of the document — see V-T48.
  main: { fontFamily: "system-ui, sans-serif", padding: "0.75rem 1rem", maxWidth: "100%", position: "relative" as const },
  heading: { margin: "0 0 0.4rem", fontSize: "1.15rem" },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  // V-T48 (Will, 2026-09-16): "Refreshing…" used to render as a <p> in
  // normal flow, so it popped in above the grid on page open and popped
  // back out a moment later, shoving the whole grid down and then back
  // up. Absolutely positioning it (anchored to styles.main above) takes
  // it out of flow entirely — mounting/unmounting it can never move
  // anything else on the page.
  refreshIndicator: {
    position: "absolute" as const,
    top: "0.6rem",
    right: "1rem",
    color: "#555",
    fontSize: "0.75rem",
    pointerEvents: "none" as const,
  },
  groupHeading: {
    fontSize: "1rem",
    fontWeight: 800,
    margin: "0 0 0.35rem",
    paddingBottom: "0.15rem",
    borderBottom: "2px solid #999",
  },
  // ⚙ settings menu — a native <details>/<summary> disclosure, same
  // pattern as round 3 (and /lots' row cog menus): a document
  // pointerdown listener (armed only while any menu is open) closes
  // every open .macro-settings-menu whose element doesn't contain the
  // click, plus Escape.
  menuDetails: { display: "inline-block", position: "relative" as const },
  menuSummary: { cursor: "pointer", listStyle: "none" as const, padding: "0 4px", border: "1px solid #ccc", borderRadius: 3, fontSize: "11px" },
  menuPanel: {
    position: "absolute" as const,
    right: 0,
    top: "100%",
    zIndex: 10,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: 4,
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    padding: "0.5rem",
    minWidth: 220,
    fontSize: "12px",
  },
  menuDoseGroup: { padding: "2px 0", borderTop: "1px solid #eee", marginTop: "2px" },
  menuRow: { display: "flex", justifyContent: "space-between", gap: "0.75rem", padding: "1px 0" },
  menuLabel: { color: "#555" },
  menuValue: { fontFamily: "ui-monospace, monospace" },
  modalOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "1rem",
  },
  modalCard: {
    background: "#fff",
    borderRadius: 8,
    padding: "1.5rem",
    maxWidth: 420,
    width: "100%",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
  },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" as const, border: "1px solid #bbb" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem", fontSize: "0.85rem" },
  checkboxRow: { display: "flex", alignItems: "flex-start", gap: "0.4rem", marginBottom: "0.75rem", fontSize: "0.85rem" },
  button: { padding: "0.3rem 0.6rem", fontSize: "13px" },
  // Version C's live-filter box, sitting above .macro-groups — same
  // plain-object convention as everything else here.
  filterBox: { margin: "0 0 0.6rem", maxWidth: 320 },
  filterInput: {
    width: "100%",
    padding: "0.4rem 0.6rem",
    fontSize: "13px",
    border: "1px solid #999",
    borderRadius: 5,
    boxSizing: "border-box" as const,
  },
  // V-macro-age-filter: the "Showing vaccines for age N / Show all" note
  // the desktop's Ctrl+Numpad4 flow relies on — visible in embed mode
  // too (unlike styles.heading above, which embed hides), just smaller
  // so it fits the popup's tight vertical budget.
  ageFilterNote: { margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#333" },
  // Macro-popup round 3: 11px -> 14px, same ~25% embed-only bump as the
  // dose-button/product-name sizes below (see lib/macro-dose-button.tsx's
  // round-3 note) — this note sits right above the same grid the buttons
  // do, so it reads oddly small next to them at the old size.
  ageFilterNoteEmbed: { margin: "0 0 6px", fontSize: 14, color: "#333" },
  ageFilterClearLink: { marginLeft: "0.5rem", color: "#0b63c5" },
} as const;

// Round 11: CopyFallback/copyToClipboard/missingNote/SECTION_COLORS now
// live in lib/macro-dose-button.tsx (see this file's new import block)
// so app/screener/page.tsx can render the exact same buttons — see that
// file's header comment for why.

// Hidden on versions A/B per Will 2026-09-12 ("Hide prices for now") —
// still unused by renderSectionVersionA/B below. ROUND 9 (Will's
// verbatim brief, 2026-09-13): "Try adding price there with the age as
// well" — version C's renderSectionVersionC now calls this for its
// compact "age · price" line; A/B are untouched.
function formatCashPrice(cents: number | null): string {
  if (cents === null) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Real default export — wraps the page in the <Suspense> boundary
 * MacroCodesPageContent's useSearchParams call requires (see this
 * file's "EMBED MODE" doc comment above). */
export default function MacroCodesPage() {
  return (
    <Suspense fallback={<AuthLoading />}>
      <MacroCodesPageContent />
    </Suspense>
  );
}

function MacroCodesPageContent() {
  const searchParams = useSearchParams();
  const embed = searchParams.get("embed") === "1";

  // V-macro-age-filter (Will's verbatim ask, 2026-09-25): the desktop's
  // new Ctrl+Numpad4 flow opens this page as
  // `/macro-codes?embed=1&age=N` (years, decimal allowed, e.g. "0.5")
  // or, for an infant, `&ageMonths=N` (integer months) — ageMonths
  // WINS over age when both are present, since it's the more precise
  // unit for that case. An invalid/unparseable value (non-numeric,
  // negative, a non-integer ageMonths) is treated the same as the
  // param being absent: no filter, no note shown — this page never
  // errors out of a malformed query string.
  const ageParam = searchParams.get("age");
  const ageMonthsParam = searchParams.get("ageMonths");
  const requestedAgeYears = useMemo(() => {
    if (ageMonthsParam !== null) {
      const months = Number(ageMonthsParam);
      return Number.isInteger(months) && months >= 0 ? months / 12 : null;
    }
    if (ageParam !== null) {
      const years = Number(ageParam);
      return Number.isFinite(years) && years >= 0 ? years : null;
    }
    return null;
  }, [ageParam, ageMonthsParam]);

  // "Show all" (rendered below, next to the age-filter note) clears the
  // filter for the rest of this page view without touching the URL —
  // simpler than a router.replace, and the desktop host doesn't need to
  // see the clear happen. Resets if the URL's age params themselves
  // change (a fresh popup open should never inherit the last one's
  // "cleared" state).
  const [ageFilterCleared, setAgeFilterCleared] = useState(false);
  useEffect(() => {
    setAgeFilterCleared(false);
  }, [ageParam, ageMonthsParam]);
  const activeAgeYears = ageFilterCleared ? null : requestedAgeYears;
  const ageFilterLabel = ageMonthsParam !== null && requestedAgeYears !== null ? `${ageMonthsParam} month${ageMonthsParam === "1" ? "" : "s"}` : ageParam ?? "";

  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineRow[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  // `loading` now means "no data at all yet, on screen or cached" — the
  // ONLY time this page shows "Loading…" (see the "instant load" doc
  // comment above). `revalidating`/`refreshNote` cover a background
  // refetch that happens WHILE something is already on screen (from
  // cache or an earlier fetch) — see loadAll below.
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<{ key: string; code: string } | null>(null);
  const [anyMenuOpen, setAnyMenuOpen] = useState(false);

  type ModalState = {
    row: MacroRow;
    /** The dose button's full descriptive label (MacroDoseButton.label,
     * e.g. "Abrysvo (75+, 18+ high-risk)") — carried through from
     * handleCopy so embed mode's post-save `vaccine-assist:macro-copied`
     * message (see handleModalSubmit) has it without recomputing it. */
    label: string;
    lotNumber: string;
    expirationIso: string;
    saveToSystem: boolean;
    submitting: boolean;
    error: string | null;
    /** Set once the copy-first step below has run, so the UI can show
     * "already copied" / the manual-copy fallback independently of
     * whatever happens afterward with the save request. */
    copyResult: { copied: boolean; code: string } | null;
    /** True once POST /api/lots has already succeeded for this modal —
     * a failed copy leaves the modal open so the user can retry Submit
     * (to re-attempt the copy), and this stops that retry from firing a
     * second, duplicate lot save. */
    saved: boolean;
  };
  const [modal, setModal] = useState<ModalState | null>(null);

  // Round 14: version C's live-filter query — the ONLY layout state this
  // page has left (see this file's ROUND 14 doc comment above). No
  // switcher, no localStorage read/write, no `embed`-forces-C special
  // case: `embed` still exists for the popup's compact styling, but
  // doesn't need to "force" a layout anymore since there's only one.
  const [filterQuery, setFilterQuery] = useState("");

  // MACRO-POPUP ROUND 3 FIX: the `<main>` DOM node, captured via a
  // callback ref (`<main ref={setEmbedContentEl}>` below) rather than a
  // plain useRef so the content-size-reporting effect further down can
  // depend on it and correctly re-run once `<main>` actually mounts —
  // see that effect's own doc comment for why a ref alone isn't enough
  // here (this page shows AuthLoading/SignInGate, with no `<main>` at
  // all, before session/authChecked resolve).
  const [embedContentEl, setEmbedContentEl] = useState<HTMLElement | null>(null);

  // MACRO-POPUP ROUND 3 FIX (code review, 2026-09-25): the lot/exp
  // modal card (styles.modalCard) below is rendered inside `<main>` in
  // the JSX tree, but its OVERLAY wrapper is `position: fixed` — a
  // fixed-position element is taken out of normal flow entirely and
  // never contributes to its parent's own rendered height, so
  // `embedContentEl`'s measured box (above) stays exactly what it was
  // with the modal closed even while the modal is open. Same callback-
  // ref pattern as embedContentEl, captured separately so the
  // content-size effect can measure the card directly and fold its
  // footprint into the reported height while it's mounted.
  const [modalCardEl, setModalCardEl] = useState<HTMLElement | null>(null);

  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setLoadError(null);
    setRefreshNote(null);
    setRevalidating(false);
    // Not clearing the cache here on purpose: it's keyed per user email
    // (lib/macro-codes-cache.ts), so a different person signing in next
    // never sees this session's cached payload anyway — clearing would
    // only cost the NEXT sign-in (even by the same person) its instant
    // first paint for no correctness benefit.
  }

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
        if (!state) resetAfterSignOut();
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  const cacheEmail = session?.email ?? null;

  /**
   * The one place this page fetches /api/vaccines + /api/lots (via
   * lib/macro-codes-cache.ts's shared fetchMacroCodesPayload, also used
   * by app/top-nav.tsx's prefetch). `background: true` is every
   * revalidation that happens while something is ALREADY on screen (a
   * cache hit on mount, focus/visibility/interval, or a post-mutation
   * refetch) — it never touches `loading`/`loadError` (which would blank
   * the page back to a spinner) and instead uses `revalidating`/
   * `refreshNote`, so the existing view stays up while it runs. A
   * SUCCESSFUL fetch — background or not — updates the cache so the
   * next mount starts from this payload.
   */
  const loadAll = useCallback(
    async (token: string, options?: { background?: boolean }) => {
      const background = options?.background ?? false;
      if (background) {
        setRevalidating(true);
      } else {
        setLoading(true);
        setLoadError(null);
      }
      const result = await fetchMacroCodesPayload(token);
      if (result.ok) {
        setVaccines(result.payload.vaccines as VaccineRow[]);
        setLots(result.payload.lots as LotRow[]);
        setLoadError(null);
        setRefreshNote(null);
        writeMacroCodesCache(getMacroCodesCacheStorage(), cacheEmail, result.payload);
      } else if (background) {
        // Brief, verbatim: "a 401/expired token never renders stale data
        // silently" — the view already on screen (cache or a previous
        // fetch) is left exactly as-is; this note is what makes clear
        // it's now UNVERIFIED rather than a quiet, ordinary success.
        setRefreshNote(
          result.unauthorized ? "Session expired — sign in again to refresh." : "Could not refresh — showing last known data."
        );
      } else {
        setLoadError(result.message);
      }
      if (background) setRevalidating(false);
      else setLoading(false);
    },
    [cacheEmail]
  );

  // Instant load (Will's brief, verbatim: "preload the info when the app
  // is first loaded so it will start fast"): the moment a session is
  // available, render whatever is cached for THIS user right away — no
  // network round trip on the critical path — then always follow up
  // with a real background fetch to correct/confirm it. A cache MISS
  // (first-ever visit, cleared storage, private browsing) falls back to
  // the original foreground load, which is the only case that still
  // shows "Loading…".
  useEffect(() => {
    if (!session) return;
    const cached = readMacroCodesCache(getMacroCodesCacheStorage(), session.email);
    if (cached) {
      setVaccines(cached.payload.vaccines as VaccineRow[]);
      setLots(cached.payload.lots as LotRow[]);
      setLoading(false);
      void loadAll(session.accessToken, { background: true });
    } else {
      void loadAll(session.accessToken);
    }
  }, [session, loadAll]);

  // Keep it fresh (brief, verbatim: "stays up to date all the time when
  // data changes"): revalidate in the background on window focus, when
  // the tab becomes visible again, and on a ~60s heartbeat while it's
  // visible — all three share the exact same background loadAll path
  // the mount-hydrate effect above uses.
  useEffect(() => {
    if (!session) return;
    const accessToken = session.accessToken;
    function revalidate() {
      if (document.visibilityState !== "visible") return;
      void loadAll(accessToken, { background: true });
    }
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    const interval = window.setInterval(revalidate, 60_000);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      window.clearInterval(interval);
    };
  }, [session, loadAll]);

  const refetchLots = useCallback(
    async (token: string) => {
      const response = await fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const nextLots = data.lots ?? [];
        setLots(nextLots);
        setRefreshNote(null);
        // Keeps the cache consistent with what just got saved (brief:
        // "refetch... after any in-page mutation") — vaccines are
        // untouched by a lot/exp save, so the current in-memory list is
        // what belongs alongside the fresh lots.
        writeMacroCodesCache(getMacroCodesCacheStorage(), cacheEmail, { vaccines, lots: nextLots });
      }
    },
    [cacheEmail, vaccines]
  );

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({ email: signInEmail, password: signInPassword });
      if (error || !data.session) {
        setSignInError(error?.message ?? "Sign-in failed.");
        return;
      }
      setSession(toSessionState(data.session));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  const productViews = useMemo(() => buildProductViews(vaccines), [vaccines]);

  const activeLotsByVaccineId = useMemo(() => {
    const map: Record<string, MacroLotLike[]> = {};
    for (const lot of lots) {
      (map[lot.vaccine_id] ??= []).push({ status: lot.status, expiration: lot.expiration, lot_number: lot.lot_number });
    }
    return map;
  }, [lots]);

  const rows = useMemo(
    () => buildMacroRows(productViews, vaccines, activeLotsByVaccineId),
    [productViews, vaccines, activeLotsByVaccineId]
  );

  const sections = useMemo(() => groupMacroRowsBySection(rows), [rows]);
  const topGroups = useMemo(() => groupSectionsByTopGroup(sections), [sections]);

  // V-macro-age-filter: the Ctrl+Numpad4 popup's age filter runs FIRST
  // (narrowing to age-eligible products, unknowns last within each
  // section — see lib/macro-codes.ts's filterMacroProductsByAge), then
  // version C's live text filter narrows that further — the two are
  // independent and compose in either order the tech uses them.
  const ageFilteredTopGroups = useMemo(() => filterMacroProductsByAge(topGroups, activeAgeYears), [topGroups, activeAgeYears]);

  // Version C's live filter — the page's only layout now, so this
  // always applies.
  const visibleTopGroups = useMemo(
    () => filterMacroTopGroups(ageFilteredTopGroups, filterQuery),
    [ageFilteredTopGroups, filterQuery]
  );

  const rowKey = macroRowKey;

  // Closes every open ⚙ menu on an outside click/tap, and on Escape —
  // same pattern as /lots' row cog menus.
  useEffect(() => {
    if (!anyMenuOpen) return;

    function closeMenusNotContaining(target: Node | null) {
      let stillOpen = false;
      document.querySelectorAll<HTMLDetailsElement>(".macro-settings-menu").forEach((el) => {
        if (!el.open) return;
        if (target && el.contains(target)) {
          stillOpen = true;
          return;
        }
        el.open = false;
      });
      setAnyMenuOpen(stillOpen);
    }

    function handlePointerDown(event: PointerEvent) {
      closeMenusNotContaining(event.target as Node);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenusNotContaining(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anyMenuOpen]);

  function handleSettingsMenuToggle() {
    const stillOpen = Array.from(document.querySelectorAll<HTMLDetailsElement>(".macro-settings-menu")).some(
      (el) => el.open
    );
    setAnyMenuOpen(stillOpen);
  }

  /** Closes the modal — used by Cancel, Escape, and an overlay click,
   * but not while a submit is in flight (matches Cancel's own disabled-
   * while-submitting behavior, so a save request can't be abandoned
   * mid-flight from underneath itself). */
  function requestCloseModal() {
    setModal((current) => (current && !current.submitting ? null : current));
  }

  async function handleCopy(row: MacroRow, label: string) {
    if (!row.macro || !row.shortCode) return;
    if (row.complete) {
      const key = rowKey(row);
      const ok = await copyToClipboard(row.macro);
      if (ok) {
        setCopyFailure(null);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
        // Embed mode (V-macro-codes-round9): a successful copy is the
        // whole point of the popup — tell the host what was picked and
        // close. A FAILED copy falls through to the copy-failure
        // fallback below instead, same in embed mode as out of it.
        if (embed) {
          postToHost({ type: "vaccine-assist:macro-copied", code: row.macro, label, product: macroProductDisplayLabel(row.displayName, row.age) });
          window.close();
        }
      } else {
        setCopiedKey(null);
        setCopyFailure({ key, code: row.macro });
      }
      return;
    }
    setCopyFailure(null);
    setModal({
      row,
      label,
      lotNumber: row.lotNumber ?? "",
      expirationIso: row.expirationIso ?? "",
      saveToSystem: row.packageSize !== 1,
      submitting: false,
      error: null,
      copyResult: null,
      saved: false,
    });
  }

  async function handleModalSubmit(event: FormEvent) {
    event.preventDefault();
    if (!modal || !session) return;
    const trimmedLot = modal.lotNumber.trim();
    if (!trimmedLot || !modal.expirationIso) return;

    const finalCode = modal.row.shortCode
      ? buildMacroCode({
          shortCode: modal.row.shortCode,
          doseNumber: modal.row.doseNumber,
          doseCount: 1,
          lotNumber: trimmedLot,
          expirationIso: modal.expirationIso,
        }).text
      : null;

    // Copy FIRST, before any await touches the network — Safari/iOS
    // revokes clipboard permission for a handler that has already
    // awaited a fetch, so on the default path (save checkbox checked)
    // copying AFTER the save+refetch silently failed there. The very
    // first await in this whole handler is this one.
    const copied = finalCode ? await copyToClipboard(finalCode) : false;

    setModal({ ...modal, submitting: true, error: null, copyResult: finalCode ? { copied, code: finalCode } : null });

    // Skip the save if a previous submit for this same modal already
    // saved it (see ModalState.saved's doc comment) — only a failed
    // copy leaves the modal open for a retry, and retrying should only
    // re-attempt the copy, not insert a second lot.
    if (modal.saveToSystem && !modal.saved) {
      try {
        const response = await fetch("/api/lots", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
          body: JSON.stringify({
            vaccine_ids: modal.row.vaccineIds,
            lot_number: trimmedLot,
            expiration: modal.expirationIso,
            status: "active",
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          // Save failed — keep the modal open with the error, but the
          // copy (or copy-fallback UI) above still reflects what
          // already happened to the clipboard.
          setModal((current) =>
            current ? { ...current, submitting: false, error: body.error ?? "Could not save the lot." } : current
          );
          return;
        }
        setModal((current) => (current ? { ...current, saved: true } : current));
        await refetchLots(session.accessToken);
      } catch (err) {
        setModal((current) =>
          current ? { ...current, submitting: false, error: err instanceof Error ? err.message : "Could not save the lot." } : current
        );
        return;
      }
    }

    if (copied) {
      setModal(null);
      // Embed mode (V-macro-codes-round9): same "copied -> tell the
      // host -> close" step as the direct-copy path in handleCopy, just
      // reached via the lot/exp modal instead — finalCode is non-null
      // here since `copied` can only be true when it was.
      if (embed && finalCode) {
        postToHost({ type: "vaccine-assist:macro-copied", code: finalCode, label: modal.label, product: macroProductDisplayLabel(modal.row.displayName, modal.row.age) });
        window.close();
      }
    } else {
      // Leave the modal open showing the manual-copy fallback rather
      // than closing on a copy that didn't actually happen.
      setModal((current) => (current ? { ...current, submitting: false } : current));
    }
  }

  // Escape closes the modal, same pattern as top-nav.tsx's account menu
  // (document-level keydown listener, only attached while open).
  useEffect(() => {
    if (!modal) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestCloseModal();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal !== null]);

  // Embed mode (V-macro-codes-round9, Will verbatim: pressing Escape
  // should back out of the whole popup): only when neither the lot/exp
  // modal nor a ⚙ menu is open — those already own Escape for their own
  // narrower close, above — Escape here posts macro-cancel and closes
  // the popup entirely, same two message channels as a successful copy.
  useEffect(() => {
    if (!embed) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (modal || anyMenuOpen) return;
      postToHost({ type: "vaccine-assist:macro-cancel" });
      window.close();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [embed, modal, anyMenuOpen]);

  // MACRO-POPUP ROUND 3 FIX (code review, 2026-09-25): the first cut of
  // this effect measured `document.documentElement.scrollHeight`, but
  // per the CSSOM View spec the ROOT element's scrollHeight is
  // `max(viewport height, content height)` — once the WebView2 viewport
  // is as tall as the window's current height, scrollHeight can never
  // report SMALLER than that again, so the window could grow for a long
  // list but never shrink back down for a short filtered one — exactly
  // Will's "extra space at the bottom" complaint this whole round
  // exists to fix. Measuring `<main>` itself instead (embedContentEl,
  // set via the `<main ref={setEmbedContentEl}>` callback ref below)
  // sidesteps that entirely: an element's own rendered box has no
  // viewport-based floor, whatever the viewport happens to be sized to
  // right now. `body { margin: 0 }` (this file's embed-only global CSS
  // rule) makes the number exact — the ~8px UA-default body margin
  // would otherwise add a stray gap around `<main>` that never shows up
  // in `<main>`'s own measured height, silently under-reporting.
  //
  // A plain useRef doesn't work here: `<main>` doesn't exist yet on the
  // renders where this page shows AuthLoading/SignInGate (before
  // authChecked/session), and this effect has no reason to re-run once
  // `embed` itself stops changing. A CALLBACK ref stored in state fixes
  // that — React calls it (and this component re-renders) the moment
  // `<main>` actually mounts, so the effect below (which depends on
  // `embedContentEl`) reruns and finds a real element instead of
  // permanently no-op'ing on a still-null ref.
  //
  // Reports after first paint, then again on every subsequent size
  // change (the live filter narrowing the grid, an age filter applying,
  // a ⚙ menu or the lot/exp modal opening, a window/font load). A
  // ResizeObserver on `embedContentEl` catches all of those without this
  // page needing to know which state changes affect layout; debounced
  // ~50ms since a ResizeObserver can fire in a tight burst for one
  // visual change (e.g. a font finishing its load). `ResizeObserver`
  // itself is guarded — some WebView2 builds may lack it — falling back
  // to just the one first-paint report with no ongoing observation.
  //
  // MODAL FIX (code review, 2026-09-25): `embedContentEl`'s own
  // getBoundingClientRect() never grows for the lot/exp modal (see
  // modalCardEl's own doc comment for why — its overlay is `position:
  // fixed`), so a narrow filtered list (near MinHeight) plus an open
  // modal could clip the modal's Save/Cancel row against the actual
  // host window. While `modalCardEl` is mounted, this effect also
  // observes IT with the same ResizeObserver, and report() sends
  // `Math.max(main height, modal card height + 48)` instead of just the
  // main height — the +48 covers the overlay's own padding around the
  // card (styles.modalOverlay's `padding: "1rem"` on every side). The
  // effect depends on `modalCardEl` too, so opening/closing the modal
  // (the ref callback firing with a real element, then null) re-runs
  // this effect and reports again immediately via the rAF first-paint
  // report below — closing the modal drops straight back to just
  // `embedContentEl`'s own height.
  useEffect(() => {
    if (!embed || !embedContentEl) return;
    // Captured into plain locals so the nested report() closure below
    // has non-null types — TS's null-narrowing on `embedContentEl`
    // above doesn't carry into a nested function declaration, since its
    // call time (inside a timeout/observer callback) isn't visible to
    // control-flow analysis.
    const element = embedContentEl;
    const modalCard = modalCardEl;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    function report() {
      const mainRect = element.getBoundingClientRect();
      let height = mainRect.height;
      if (modalCard) {
        height = Math.max(height, modalCard.getBoundingClientRect().height + 48);
      }
      postContentSize(mainRect.width, height);
    }
    function scheduleReport() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(report, 50);
    }
    // First paint: rAF so this runs after the browser has actually laid
    // out the frame the mount produced, not synchronously during it —
    // also the entire size-reporting path when ResizeObserver is
    // unavailable (see the guard below): one report, no further updates.
    const firstPaintFrame = requestAnimationFrame(scheduleReport);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(scheduleReport);
      observer.observe(element);
      if (modalCard) observer.observe(modalCard);
    }
    return () => {
      cancelAnimationFrame(firstPaintFrame);
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      observer?.disconnect();
    };
  }, [embed, embedContentEl, modalCardEl]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view macro codes."
        email={signInEmail}
        password={signInPassword}
        onEmailChange={setSignInEmail}
        onPasswordChange={setSignInPassword}
        onSubmit={handleSignIn}
        error={signInError}
        submitting={signingIn}
      />
    );
  }

  /**
   * Round 8: renderDoseButton grew three optional layout knobs so all
   * three versions can share it (per the brief: copy/modal/⚙/hidden-
   * price behavior must be identical, reused, not reimplemented):
   * - `visibleLabel`: shown instead of the full `dose.label` (e.g.
   *   version B/C's short "Dose 1"/"One dose" — see lib/macro-codes.ts's
   *   doseButtonShortLabel) while every click/copy/modal/tooltip/title
   *   still uses the full descriptive label underneath, unchanged.
   * - `block`: version A's one-per-line vertical stack — full width,
   *   left-aligned text, instead of an inline pill sized to its label.
   * - `large`: version C's bigger hit target (Will's brief: "larger hit
   *   targets").
   * - `subLabel` (ROUND 10): an optional second, tiny/muted line —
   *   version B/C's per-dose schedule interval (MacroRow.doseInterval,
   *   e.g. "2 mo" under a "Dose 2" button) — capped to a fixed max-width
   *   with an ellipsis so a long interval (Gardasil/MMR's multi-clause
   *   text) can't blow up the button; the FULL text still reaches the
   *   button's `title` (see the title computation below) so nothing is
   *   lost, just not all visible at once.
   * - `topLabel` (ROUND 14, V-T48): an optional new FIRST line, above
   *   `visibleLabel` — renderSectionVersionC passes the product's
   *   displayName here so every button shows name (row 1) / dose
   *   (row 2) / schedule (row 3, when present).
   * The click handler, disabled state, "Copied ✓" swap, missing-lot/exp
   * red dot, and copy-failure fallback are untouched from round 7.
   */
  function renderDoseButton(
    dose: MacroDoseButton,
    colors: SectionColors,
    options?: {
      topLabel?: string;
      visibleLabel?: string;
      subLabel?: string;
      block?: boolean;
      large?: boolean;
      fitRow?: boolean;
      doseCountInRow?: number;
      reserveSubLabelSlot?: boolean;
    }
  ) {
    const { row, label } = dose;
    const key = rowKey(row);
    return renderMacroDoseButton(dose, colors, {
      isCopied: copiedKey === key,
      copyFailureCode: copyFailure?.key === key ? copyFailure.code : null,
      onClick: () => void handleCopy(row, label),
      compact: embed,
      ...options,
    });
  }

  function renderSettingsMenu(product: MacroProductGroup) {
    const realDoses = product.doses.filter((d) => d.row.shortCode !== null);
    if (realDoses.length === 0) return null;
    const ndc = formatNdcDisplay(realDoses[0].row.ndc);

    return (
      <details className="macro-settings-menu" style={styles.menuDetails} onToggle={handleSettingsMenuToggle}>
        <summary style={styles.menuSummary} aria-label={`${macroProductDisplayLabel(product.displayName, product.age)} details`}>
          ⚙
        </summary>
        <div style={styles.menuPanel}>
          <div style={styles.menuRow}>
            <span style={styles.menuLabel}>NDC</span>
            <span style={styles.menuValue}>{ndc}</span>
          </div>
          {realDoses.map((dose) => (
            <div key={rowKey(dose.row)} style={styles.menuDoseGroup}>
              <div style={styles.menuRow}>
                <span style={styles.menuLabel}>{realDoses.length > 1 ? `Dose ${dose.row.doseNumber} code` : "Short code"}</span>
                <span style={styles.menuValue}>{dose.row.shortCode}</span>
              </div>
              <div style={styles.menuRow}>
                <span style={styles.menuLabel}>{realDoses.length > 1 ? `Dose ${dose.row.doseNumber} macro` : "Macro text"}</span>
                <span style={styles.menuValue}>{dose.row.macro}</span>
              </div>
            </div>
          ))}
        </div>
      </details>
    );
  }

  // Round 14: versions A and B (renderSectionVersionA/B) are deleted —
  // see this file's ROUND 14 doc comment. Version C (below) is the only
  // layout left.

  /**
   * Version C — "Scan grid," a from-scratch layout aimed squarely at
   * Will's stated goal: a pharmacy tech scanning ~25 products to find
   * ONE fast. Design choices (each addresses one part of the brief):
   *
   * - Live filter-as-you-type (lib/macro-codes.ts's
   *   filterMacroTopGroups), not an A–Z index rail: a tech almost always
   *   already knows the product or short code they need, so typing a
   *   few letters narrows straight to it in one motion. An alphabetical
   *   index instead requires the tech to know which LETTER their target
   *   starts under across an already-alphabetically-scattered catalog
   *   (products are grouped by disease family, not name), which is an
   *   extra translation step the filter avoids entirely — and the
   *   filter also matches a section family name ("tdap", "flu") and
   *   short codes, not just the display name, so it works as a family
   *   jump-to as well as a product search.
   * - High-contrast per-family color BANDS (macro-section-band below):
   *   reuses SECTION_COLORS' existing border hue as a solid heading
   *   background instead of the subtle per-button tint every other
   *   version uses, so a family boundary is visible from across the
   *   room, not just on close reading.
   * - A single two-column CSS grid template (name | buttons) shared by
   *   EVERY row in every section (.macro-row-c below) keeps the name
   *   column's left edge and the button column's right edge each
   *   perfectly vertically aligned down the whole page, so the eye
   *   tracks one straight line instead of re-finding the edge per row.
   * - Larger hit targets: renderDoseButton's `large` option (38px tall,
   *   more horizontal padding) vs. the 32px default elsewhere.
   * - Dose buttons right-aligned (`justify-content: flex-end` on
   *   .macro-dose-buttons-c) so, combined with the fixed grid template
   *   above, every button column lines up on the right edge too.
   *
   * One-screen fit at 1920×1080: the existing three-column COVID/Flu |
   * Common | Other layout already spreads the catalog's ~13 sections
   * and ~25 products across three columns instead of one long list, and
   * this version's rows are intentionally compact (small band headings,
   * ~2px row gaps, no separate age row). Rough arithmetic says this
   * fits: the "Other" column (the deepest, with the most sections —
   * Hep B, Meningitis, Hep A, Typhoid, MMR, Other) has roughly a dozen
   * product rows plus band headings, each row/band well under 30px
   * tall, putting that column at well under 500px — nowhere near a
   * 1080px viewport (minus browser chrome and this page's own header/
   * switcher). This is arithmetic, not a measured screenshot — it
   * hasn't been verified pixel-for-pixel in a real browser at that
   * resolution. If a future catalog addition (a new section, or several
   * new products piling into one already-long column) ever does push a
   * column past one screen, the live filter above is also the fallback:
   * typing even one character immediately drops every non-matching row
   * and the page fits again — the filter isn't just a search feature
   * here, it's the page's own answer to "what if it doesn't fit."
   *
   * ROUND 9 (Will's verbatim feedback, 2026-09-13, replying to round 8:
   * "I like C so far, but keep all the options for now. Let's work on
   * improving C") polishes the name/age column and the columns' overall
   * width, all still on the SAME two-column grid/data pipeline above:
   * - Product name is now its own bold, slightly larger line
   *   (.macro-product-name-c) instead of sharing one line with the age
   *   via macroProductNameWithAge (still used by A/B, untouched here).
   * - A second, small gray line (.macro-product-meta-c) holds the
   *   compact base age range (MacroProductGroup.ageBase — the qualifier
   *   clause is NOT repeated here, see the ⓘ below) plus the cash price
   *   when known, joined by " · " (formatCashPrice — still hidden on
   *   A/B, per Will's round-6 "hide prices for now").
   * - A product with a special qualification (MacroProductGroup.note)
   *   gets a small ⓘ right after the age/price line — a focusable span
   *   (tabIndex 0) carrying both `title` (mouse hover, and a fallback
   *   for anything that ignores the CSS tooltip) and `aria-label` (screen
   *   readers), plus a CSS-only tooltip (.macro-note-tooltip below) shown
   *   on `:hover`/`:focus-visible` — no new dependency, same "plain CSS,
   *   no popover library" posture as every other interaction on this
   *   page.
   * - Columns no longer stretch edge-to-edge: renderTopGroup below gives
   *   version C's .macro-group-column a fixed content-sized basis
   *   instead of flex:1, and the .macro-groups-c wrapper caps the whole
   *   three-column row at max-width ~1200px, left-aligned under the
   *   page's own H1 (both already start at the same left padding) —
   *   Will's brief: "make the table a little more compact width-wise...
   *   the dead space going away will make it easier to use."
   * - Row vertical padding bumped to ~6px (.macro-row-c) per the same
   *   brief; still not measured pixel-for-pixel at 1920×1080/1440×900 —
   *   same caveat as the one-screen-fit note above, and the live filter
   *   is still the fallback if a wide catalog ever overflows.
   */
  function renderSectionVersionC(section: MacroSectionGroup) {
    const colors = SECTION_COLORS[section.section];
    // Macro-popup round 3 (Will's verbatim ask, 2026-09-25): the old
    // "EMBED COMPACT" sizes here (fontSize 11/13/10, padding "2px 6px",
    // row padding "4px 0") targeted a fixed 980x760 window and shrank
    // everything to fit inside it without scrolling — that fixed target
    // is gone now that the host sizes its window TO this page's content
    // (see this file's own round-3 doc comment near the top and
    // MacroCodesWindow.xaml.cs), so every size below instead grew
    // ~20-25%, same bump as the dose buttons themselves (lib/macro-
    // dose-button.tsx's round-3 note) — every value below is still
    // inline (not a CSS class) so it only ever applies in embed mode and
    // never touches the normal, non-embed layout-C page.
    const bandStyle = embed
      ? { background: colors.border, fontSize: 14, padding: "3px 8px", margin: "4px 0 2px" }
      : { background: colors.border };
    const rowStyle = embed ? { padding: "6px 0" } : undefined;
    const nameStyle = embed ? { fontSize: 16, lineHeight: 1.15 } : undefined;
    const metaStyle = embed ? { fontSize: 13, marginTop: 0 } : undefined;
    return (
      <section key={section.section} className="macro-section macro-section-c" style={embed ? { marginBottom: 4 } : undefined}>
        <h2 className="macro-section-band" style={bandStyle}>
          {macroSectionDisplayName(section.section)}
        </h2>
        {section.products.map((product) => {
          const doseCount = product.doses.length;
          const price = formatCashPrice(product.cashPriceCents);
          const metaText = price ? `${product.ageBase} · ${price}` : product.ageBase;
          return (
            <div key={product.productKey} className="macro-row macro-row-c" style={rowStyle}>
              <div className="macro-product-name-cell-c">
                <div className="macro-product-name-c" style={nameStyle}>{macroProductDisplayLabel(product.displayName, product.age)}</div>
                <div className="macro-product-meta-c" style={metaStyle}>
                  {metaText}
                  {product.note && (
                    <span
                      className="macro-note-icon"
                      tabIndex={0}
                      title={product.note}
                      aria-label={`Special qualification: ${product.note}`}
                    >
                      <span aria-hidden="true">ⓘ</span>
                      <span className="macro-note-tooltip" aria-hidden="true">
                        {product.note}
                      </span>
                    </span>
                  )}
                </div>
              </div>
              <div className="macro-dose-buttons-c">
                {product.doses.map((dose) =>
                  // V-T50: per-product flu color override (Flucelvax
                  // green, FluMist gray, mFLUSIVA red) when one exists,
                  // else the section color used everywhere else — see
                  // lib/macro-dose-button.tsx's PRODUCT_COLORS/
                  // resolveDoseButtonColors.
                  renderDoseButton(dose, resolveDoseButtonColors(dose.row), {
                    // ROUND 14 (V-T48): the vaccine name as the button's
                    // own first row, above the existing dose row (2) and
                    // schedule row (3, where present) — see this file's
                    // ROUND 14 doc comment.
                    topLabel: macroProductDisplayLabel(product.displayName, product.age),
                    visibleLabel: doseButtonShortLabel(dose.row, doseCount),
                    subLabel: dose.row.doseInterval,
                    large: true,
                    // ROUND 13 (Will's verbatim feedback via the
                    // coordinator, 2026-09-13, on top of round 12's font-
                    // parity fix: at common widths like 1456px, layout C
                    // was dropping to two columns with "Other" wrapping
                    // underneath — a big empty area on the right, exactly
                    // the "dead space" complaint this whole round started
                    // from). `fitRow` (round 11's equal-share, shrink-to-
                    // fit mechanic) is dropped here: buttons now size to
                    // their own natural content width (this file's
                    // default, non-fitRow button sizing) and NEVER shrink
                    // (.macro-dose-buttons-c below is flex: 0 0 auto,
                    // still flex-wrap: nowrap so 3 doses never wrap to a
                    // second line) — the row's OTHER side
                    // (.macro-product-name-cell-c) is what shrinks/
                    // ellipsizes instead when a row runs tight, so the
                    // buttons the user clicks are never squeezed.
                    // reserveSubLabelSlot (round 11, still needed): dose 1
                    // never has an interval, so it still gets an empty
                    // placeholder line rather than being one line shorter
                    // than its siblings.
                    reserveSubLabelSlot: product.doses.some((d) => Boolean(d.row.doseInterval)),
                  })
                )}
              </div>
              <div className="macro-settings-cell">{renderSettingsMenu(product)}</div>
            </div>
          );
        })}
      </section>
    );
  }

  function renderTopGroup(block: MacroTopGroupBlock) {
    // ROUND 13 (Will's verbatim feedback via the coordinator, 2026-09-13):
    // fixed-width flex columns (round 12's 460px basis) don't reliably
    // fit three across at common widths — 1456px rendered only two
    // columns, wrapping "Other" onto its own row with a lot of empty
    // space beside it. .macro-groups-c (below) is now a CSS grid —
    // `grid-template-columns: repeat(3, minmax(0, 1fr))` — which always
    // lays out exactly three tracks sharing the row's width, never wraps
    // to fewer, and never needs a per-column flex-basis/min-width here:
    // `minWidth: 0` is the only thing a column itself needs, so its
    // CONTENT (not the column box) is what's free to shrink — see
    // renderSectionVersionC's .macro-product-name-cell-c/
    // .macro-dose-buttons-c for which side of a row actually gives up
    // space when a column gets narrow. This one grid rule also covers
    // embed (round 14: C is the only layout, embed included, so this is
    // unconditional): the 1100px popup gets the same three even tracks,
    // just with a smaller gap (see the .macro-groups-c wrapper's own
    // style below).
    const columnStyle = { minWidth: 0 };
    return (
      <div key={block.group} className="macro-group-column" style={columnStyle}>
        <h2 style={styles.groupHeading}>{block.group}</h2>
        {block.sections.map((section) => renderSectionVersionC(section))}
      </div>
    );
  }

  return (
    <main
      ref={setEmbedContentEl}
      style={embed ? { ...styles.main, padding: "12px 24px" } : styles.main}
    >
      {!embed && <h1 style={styles.heading}>Macro codes</h1>}

      {/* V-macro-age-filter: shown whenever an age filter is active,
       * regardless of embed — this note is the whole point of the
       * Ctrl+Numpad4 flow, so it can't be hidden by embed mode's
       * no-heading rule the way the plain "Macro codes" <h1> above is. */}
      {activeAgeYears !== null && (
        <p style={embed ? styles.ageFilterNoteEmbed : styles.ageFilterNote}>
          Showing vaccines for age {ageFilterLabel}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setAgeFilterCleared(true);
            }}
            style={styles.ageFilterClearLink}
          >
            Show all
          </a>
        </p>
      )}

      {/* Embed (2026-09-13; sizing rationale updated by macro-popup round
       * 3, 2026-09-25 — see this file's top-of-file doc comment): only
       * the margin shrinks here — width/position/autoFocus are untouched
       * so the box stays visible and focused at top. */}
      <div style={embed ? { ...styles.filterBox, margin: "0 0 6px" } : styles.filterBox}>
        <input
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter by name or code…"
          aria-label="Filter vaccines"
          style={styles.filterInput}
          autoFocus={embed}
        />
      </div>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}
      {/* ROUND 12: a background revalidation never blanks the page (see
       * loadAll's doc comment) — this is the only visible sign one is in
       * flight, or that the last one failed/hit an expired token while
       * the view above kept showing cached/previous data. */}
      {!loading && revalidating && (
        <span style={styles.refreshIndicator} aria-live="polite">
          Refreshing…
        </span>
      )}
      {!loading && !revalidating && refreshNote && <p style={styles.error}>{refreshNote}</p>}

      {!loading && (
        <div
          className="macro-groups macro-groups-c"
          style={
            // ROUND 13 (Will's verbatim feedback via the coordinator,
            // 2026-09-13): fixed-width flex columns don't reliably fit
            // three across (1456px was dropping to two, wrapping "Other"
            // onto its own row with a lot of empty space beside it) — a
            // CSS grid with a literal 3-track template ALWAYS renders
            // three columns sharing the row's width, at any width, and
            // never wraps to fewer. This one grid rule covers embed too
            // (round 14: C is the only layout, embed included): the
            // 1100px popup gets the same three even tracks, just a
            // smaller gap and no width cap.
            {
              display: "grid" as const,
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              alignItems: "flex-start" as const,
              gap: embed ? "10px" : "1.5rem",
              maxWidth: embed ? "100%" : 1440,
            }
          }
        >
          {visibleTopGroups.map((block) => renderTopGroup(block))}
        </div>
      )}

      {/* MACRO-POPUP ROUND 3 FIX (code review, 2026-09-25): with no
       * fallback text here, a name filter narrowed to 0 rows rendered
       * NOTHING below the filter box — `<main>`'s own measured height
       * (the content-size effect above) would collapse toward the
       * MinHeight floor on the desktop side, and an unlucky lot/exp
       * modal open in that state had very little headroom before this
       * round's own modal-height fix (modalCardEl above) existed. Keeps
       * `<main>` from ever collapsing that far regardless. */}
      {!loading && visibleTopGroups.length === 0 && <p style={styles.muted}>No codes match.</p>}

      {modal && (
        <div
          style={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            // Overlay click closes; a click that started inside the
            // card (bubbling up) has e.target !== the overlay itself,
            // so it's excluded here without needing stopPropagation.
            if (e.target === e.currentTarget) requestCloseModal();
          }}
        >
          <div ref={setModalCardEl} style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>
              Enter lot / exp for {macroProductDisplayLabel(modal.row.displayName, modal.row.age)} dose {modal.row.doseNumber}
            </h2>
            {modal.copyResult && !modal.copyResult.copied && <CopyFallback code={modal.copyResult.code} />}
            <form onSubmit={handleModalSubmit}>
              <label style={styles.label} htmlFor="macro-modal-lot">
                Lot number
              </label>
              <input
                id="macro-modal-lot"
                style={styles.field}
                type="text"
                value={modal.lotNumber}
                onChange={(e) => setModal({ ...modal, lotNumber: e.target.value })}
                autoFocus
              />

              <label style={styles.label} htmlFor="macro-modal-exp">
                Expiration
              </label>
              <DateTextInput
                value={modal.expirationIso}
                onChange={(iso) => setModal((current) => (current ? { ...current, expirationIso: iso } : current))}
                ariaLabel="Expiration"
                style={styles.field}
              />

              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={modal.saveToSystem}
                  onChange={(e) => setModal({ ...modal, saveToSystem: e.target.checked })}
                />
                <span>
                  Save this lot/exp to the system
                  {modal.row.packageSize === 1 && (
                    <>
                      <br />
                      <span style={styles.muted}>Not recommended for single-dose packages (pkg size 1).</span>
                    </>
                  )}
                </span>
              </label>

              {modal.error && (
                <p style={styles.error}>
                  {modal.error}
                  {modal.copyResult?.copied && " (the code was already copied to your clipboard)"}
                </p>
              )}

              <p style={{ textAlign: "right", marginBottom: 0 }}>
                <button type="button" style={styles.button} onClick={requestCloseModal} disabled={modal.submitting}>
                  Cancel
                </button>{" "}
                <button
                  type="submit"
                  style={styles.button}
                  disabled={modal.submitting || !modal.lotNumber.trim() || !modal.expirationIso}
                >
                  {modal.submitting ? "Saving…" : "Submit"}
                </button>
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Row-level interaction styling that plain inline styles can't
       * express (hover/focus states) — same "no external library"
       * posture as app/appointments/explorer/page.tsx's <style>
       * keyframes tag. The ⚙ column is opacity:0 by default and only
       * appears on row hover/focus-within, EXCEPT on touch devices (no
       * hover) where it's always visible, since a touch user can't
       * "hover" to reveal it. Dose buttons are real <button>s so
       * Enter/Space work natively with no extra keyboard handling.
       *
       * Round 6: .macro-groups is the three-column ("COVID/Flu" |
       * "Common" | "Other") layout replacing round 5's 4-column text
       * flow — plain inline styles can't express the narrow-width
       * media query, so the stack-to-one-column fallback below 1100px
       * lives here. Each column stacks its own sections top to bottom
       * (no multi-column text flow within a column).
       *
       * Round 8 adds: the view-switcher button active/hover state; the
       * version-A family-row/dose-stack layout; version B's four-column
       * row grid; and version C's color band heading + two-column row
       * grid with right-aligned buttons.
       *
       * Round 9 embed mode adds: hiding the shared top nav (targeting
       * top-nav.tsx's `data-top-nav` hook — TopNav's own code is
       * untouched) and forcing a white body background, both global
       * rules scoped to embed mode by only being emitted at all when
       * `embed` is true.
       *
       * MACRO-POPUP ROUND 3 (Will's verbatim ask, 2026-09-25) RETIRES the
       * old "EMBED COMPACT" fixed-980x760-target arithmetic that used to
       * live in this comment: the popup no longer aims for a fixed size
       * at all — the page reports its own real rendered height to the
       * desktop host (postContentSize, in the effect above) and the host
       * resizes its window to match (see MacroCodesWindow.xaml.cs). Two
       * consequences for the CSS below: the `overflow: hidden` this
       * embed body rule used to force is GONE — a window clamped to a
       * small monitor's work area can still end up shorter than the
       * content, and when it does the WebView2 control needs to scroll
       * internally rather than clip content the pharmacist can't get to
       * — and every embed-only size (bandStyle/rowStyle/nameStyle/
       * metaStyle in renderSectionVersionC, ageFilterNoteEmbed, `<main>`'s
       * embed padding) grew ~20-25% instead of shrinking to fit, per the
       * brief ("make it look sleaker and easy to read and interact
       * with"). The @media (max-width: 1100px) one-column stacking rule
       * below is unrelated to any of this and unchanged — it's the
       * phone-width fallback for the page's normal, non-embed use too. */}
      <style>{`
        ${embed ? "nav[data-top-nav] { display: none !important; } body { background: #fff !important; margin: 0 !important; }" : ""}
        .macro-groups {
          flex-wrap: wrap;
        }
        @media (max-width: 1100px) {
          .macro-groups { flex-direction: column; }
          .macro-group-column { width: 100%; }
        }
        .macro-section {
          margin-bottom: 0.5rem;
        }
        .macro-dose-button:hover, .macro-dose-button:focus-visible {
          filter: brightness(0.96);
          outline: none;
        }
        .macro-dose-button:disabled { cursor: default; }
        .macro-settings-menu { opacity: 0; }
        .macro-row:hover .macro-settings-menu,
        .macro-row:focus-within .macro-settings-menu,
        .macro-settings-menu[open] {
          opacity: 1;
        }
        @media (hover: none) {
          .macro-settings-menu { opacity: 1; }
        }

        /* Version C: high-contrast family band + a two-column grid
         * (name | right-aligned buttons) shared by every row so columns
         * stay aligned straight down the page. Round 9: columns stop
         * stretching full width (.macro-groups-c caps the whole row at
         * max-width via inline style + renderTopGroup's per-column
         * fixed basis above), rows get ~6px vertical padding, and the
         * name column splits into a bold name line + a small gray
         * age/price line with an optional ⓘ qualification tooltip. */
        .macro-groups-c {
          justify-content: flex-start;
        }
        .macro-section-band {
          font-size: 0.75rem;
          font-weight: 800;
          color: #fff;
          padding: 3px 8px;
          border-radius: 4px;
          margin: 0.4rem 0 0.15rem;
        }
        /* ROUND 10 FIX (live screenshot, layout C @ 1456px): Gardasil 9's
         * Dose 2/3 buttons were wide enough that the grid's "auto" button
         * column pushed left over the name column, wrapping "Dose 1"
         * onto two lines and shoving the price line under the buttons.
         * Switched from a fixed 3-column grid to flex so the button
         * group can wrap to a second line UNDER itself instead of
         * colliding with the name.
         * ROUND 13 (Will's verbatim feedback via the coordinator,
         * 2026-09-13): a grid COLUMN (this file's outer .macro-groups-c)
         * can be much narrower now than round 9/12 assumed (three tracks
         * sharing the row, not a fixed 460px basis), so this inner row
         * flips which side gives up space first — the dose-button group
         * (.macro-dose-buttons-c) is flex: 0 0 auto (sized to its own
         * buttons' natural content, never shrunk, never wrapped — those
         * are what the user clicks) and the name/price side
         * (.macro-product-name-cell-c) is flex: 1 1 auto with min-width:
         * 0, so IT is what shrinks and ellipsizes when a column gets
         * tight, never the buttons. */
        .macro-row-c {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 6px 0;
          border-bottom: 1px solid #eee;
        }
        .macro-product-name-cell-c {
          flex: 1 1 auto;
          min-width: 0;
        }
        .macro-product-name-c {
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .macro-row-c > .macro-settings-cell {
          flex: 0 0 auto;
        }
        .macro-product-meta-c {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: #666;
          line-height: 1.2;
          margin-top: 1px;
        }
        .macro-note-icon {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 1px solid #888;
          font-size: 10px;
          line-height: 1;
          color: #666;
          cursor: help;
        }
        .macro-note-icon:hover,
        .macro-note-icon:focus-visible {
          border-color: #333;
          color: #333;
        }
        .macro-note-icon:focus-visible {
          outline: 2px solid #333;
          outline-offset: 2px;
        }
        .macro-note-tooltip {
          visibility: hidden;
          opacity: 0;
          position: absolute;
          bottom: 130%;
          left: 50%;
          transform: translateX(-50%);
          background: #333;
          color: #fff;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 400;
          white-space: nowrap;
          z-index: 20;
          transition: opacity 0.1s ease;
        }
        .macro-note-icon:hover .macro-note-tooltip,
        .macro-note-icon:focus-visible .macro-note-tooltip {
          visibility: visible;
          opacity: 1;
        }
        .macro-dose-buttons-c {
          display: flex;
          /* ROUND 11 (Will's verbatim feedback: "I want all the buttons
           * to fit on one row, so if there are 3 doses, they all need to
           * fit"): never wrap to a second line.
           * ROUND 12 (Will's verbatim feedback: "I want the dose 1/2/3
           * font size to be the same as the other buttons... increase
           * width of the table"): the per-doseCount font/padding shrink
           * is gone (lib/macro-dose-button.tsx).
           * ROUND 13 (Will's verbatim feedback via the coordinator): the
           * round-11 "flex to share the row equally, shrink if crowded"
           * mechanic (fitRow) is gone too — this group is now flex: 0 0
           * auto, sized to exactly what its own buttons need at their
           * FULL size, and never shrinks; see .macro-row-c's doc comment
           * above for which side gives up space instead. */
          flex: 0 0 auto;
          flex-wrap: nowrap;
          gap: 0.3rem;
          justify-content: flex-end;
          margin-left: auto;
        }

        @media (max-width: 700px) {
          .macro-row-c {
            flex-direction: column;
            align-items: flex-start;
          }
          .macro-product-name-cell-c,
          .macro-dose-buttons-c {
            max-width: 100%;
          }
          .macro-dose-buttons-c {
            justify-content: flex-start;
            margin-left: 0;
            /* Phone-width fallback: the row is already stacked (name
             * above, buttons below, full width) here, so there's no
             * "layout C / embed column" fit-on-one-row constraint to
             * honor — let a genuinely long dose group wrap instead of
             * squeezing to unreadable sizes. */
            flex-wrap: wrap;
          }
        }
      `}</style>
    </main>
  );
}
