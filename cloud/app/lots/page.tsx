"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { pickCurrentActiveLot } from "@/lib/lots-table";
import { lotRowExpiredOn, lotRowStatus } from "@/lib/lots-row-status";
import { dedupeLotsByNumber, formatInactiveSummaryLabel, partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { buildProductViews, type ProductView } from "@/lib/product-view";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { formatNdcDashed } from "@/lib/ndc";
import { isoToMaskedDate } from "@/lib/date-mask";
import {
  createDebouncedRunner,
  decideDateAutosave,
  decideLotNumberAutosave,
  rowStatusLabel,
  type DebouncedRunner,
} from "@/lib/lots-autosave";
import { plusDaysIso } from "@/lib/lots-bud-shortcut";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";
import ErrorToast, { useErrorToasts } from "@/app/error-toast";

/**
 * /lots page, round 3 (V-T-ordering-lots-round3, Will 2026-09-09
 * verbatim): "Make it much more compact. The table is wildly
 * inefficient. Remove explainer text and refresh button (there is
 * nothing to refresh here). Make sure the data on the ordering/lots page
 * matches (NDC, name, etc) and is consistent always. It should pull from
 * the same database. Beyond-use date only needs to apply to mNexspike
 * right now. Add a settings menu icon to the end of each row where you
 * can enable Beyond Use Date too. Put active/inactive in there. Follow
 * same groupings everywhere, including on lots, so put all Flu shots
 * together, COVID, then Other." Plus (4:29pm, verbatim): "Put COVID and
 * flu groups first, then other" (confirms the group order below) and
 * the expiration/beyond-use fields must be typed MM/DD/YYYY text, never
 * a native date-picker (see app/date-text-input.tsx).
 *
 * Rows/columns/fields:
 *   - One row per PRODUCT (lib/product-view.ts's buildProductViews —
 *     the SAME shared helper /ordering uses, so name/NDC/pkg-size/group
 *     are identical between the two pages, pulled from the same
 *     `vaccine` table).
 *   - Grouped COVID / Flu / Other (lib/ordering-group.ts, same order as
 *     Ordering), dark group-heading rows, no totals.
 *   - Compact spreadsheet styling matching Ordering's table (2px 6px
 *     padding, 13px font, thin 1px borders).
 *   - Columns: Product · NDC · Units/pkg (renamed from "Pkg size",
 *     V-onhand-ndc-units — value unchanged, still the catalog's static
 *     dosesPerPackage) · Lot # · Expiration ·
 *     [Beyond-use date, only when enabled for that specific product] ·
 *     ⚙ (+ Save). The Active checkbox and Delete-lot button that used to
 *     sit in the row are now inside the ⚙ menu, alongside a new "Show
 *     beyond-use date" toggle.
 *   - Beyond-use-date enablement is a per-PRODUCT setting persisted
 *     server-side (GET/PUT /api/lots/settings, app_setting key
 *     `lots.bud_enabled_products`) — defaults to mNEXSPIKE only when
 *     nothing's been saved yet (lib/lots-settings.ts).
 *   - Inactive products stay listed under their group, greyed, sorted to
 *     the bottom of that group's rows (no separate collapsed section
 *     anymore).
 *   - V-lots-status-column (Will 2026-09-14 verbatim: "when updating, it
 *     shows 'saving' and messes up the formatting of the whole table...
 *     make it append to the end of the row"): a row's save status
 *     (Saving…/Saved ✓/error) used to render inline right after the ⚙
 *     menu, so its varying width reflowed the whole (auto-layout, 100%
 *     width) table on every save. Fixed with a dedicated, always-present
 *     last "status" column (blank header, fixed width, right-aligned,
 *     nowrap) plus `table-layout: fixed` with an explicit <colgroup> so no
 *     column's width is ever recomputed from row content. See
 *     lib/lots-autosave.ts's rowStatusLabel for the pure priority logic
 *     (saving > error > justSaved > expired > missing > nothing) and
 *     savedFlashByKey/flashSaved below for the ~1.5s fade timing.
 *   - V-lots-row-status (Will 2026-09-14 verbatim: "If a lot is missing,
 *     highlight the row in yellow. If it's expired, highlight it in red.
 *     And add a note at the end of the row that shows that status."; same
 *     day, verbatim: "Also needs to show if exp is missing too"): an
 *     ACTIVE row's background is pale yellow when it has no lot number
 *     OR no expiration date on file, pale red when its earliest set date
 *     (expiration, or beyond-use date if earlier) is in the past — see
 *     lib/lots-row-status.ts's lotRowStatus, which replaces this page's
 *     old isLotRowDue/resolveLotRowHighlight highlight entirely (that one
 *     didn't know about a missing lot at all, and used an inclusive
 *     "expires today" boundary this brief deliberately does not).
 *     Inactive still wins over any of these, same as before — an
 *     inactive product's own missing/expired lot is no longer
 *     actionable.
 *   - V-lots-collapse-inactive (Will 2026-09-14 verbatim: "Inactive
 *     vaccines put into a collapsed menu"): the Inactive section renders
 *     as a native <details>/<summary> disclosure, collapsed by default,
 *     with the count appended to its label ("Inactive (12)") and a
 *     ▸/▾ indicator. Open/closed state persists per-browser in
 *     localStorage (key vaccine-assist:lots:inactiveOpen). Since a
 *     <details> can't validly wrap <tr>s inside the active table's own
 *     <tbody>, the inactive rows live in a SECOND <table> (inside the
 *     <details>) that repeats the exact same <colgroup> as the first
 *     table — see renderLotsColgroup below — so its columns stay
 *     pixel-identical to the table above it.
 *   - V-lots-bud-30d-shortcut (Will 2026-09-24 4:24pm verbatim: "for
 *     beyond use date, add a 30d little link next to the right side of
 *     the box that sets the BUD to 30 days from today"): a small
 *     de-emphasized "30d" link sits beside a row's beyond-use-date box,
 *     shown only when that box itself is (i.e. only when the product's
 *     BUD setting is enabled — see budEnabledForThisProduct). Clicking it
 *     sets the row's beyond-use date to 30 days from the browser's local
 *     date (lib/lots-bud-shortcut.ts's plusDaysIso) and flushes it
 *     through the SAME runAutosave path a typed date goes through — see
 *     handleBudShortcut below for why it writes draftsRef/rawDateTextRef
 *     directly instead of only going through updateDraft/
 *     updateRawDateText's usual setState form.
 *
 * Saving/deleting a product row's lot still fans out server-side to
 * every dose vaccine_id in the group (POST/PATCH/DELETE /api/lots,
 * vaccine_ids / vaccineIds — see that route's own doc comment), and the
 * Active toggle still loops PATCH /api/vaccines/{id} across the group's
 * vaccine_ids client-side, both unchanged from before this round.
 */

type VaccineOption = { id: string; name: string; active: boolean; ndc: string | null };

type LotRow = {
  id: string;
  vaccine_id: string;
  lot_number: string;
  // Nullable since V-lots-clear-save follow-up (supabase/migrations/
  // 0014_...): clearing ONLY the expiration is now a persisted UPDATE,
  // not a delete — draftsFromProducts below already collapses this to
  // "" via `current?.expiration ?? ""`, so downstream draft/highlight
  // logic never sees the null itself.
  expiration: string | null;
  status: string;
  note: string | null;
  beyond_use_date?: string | null;
};

/**
 * Per-PRODUCT draft state — separate from the loaded LotRow so
 * in-progress edits don't get clobbered by a background refresh, and so
 * a brand-new (no lot yet) row has somewhere to hold its inputs before
 * the first save. `matchLotNumber` is the lot number as LOADED (before
 * any in-progress edit) — null means the product has no current lot yet
 * (Save will create one); non-null is what a Save/Delete's fan-out
 * request matches against on every dose vaccine_id, since the edited
 * `lotNumber` field itself may be a rename in flight.
 */
type RowDraft = { matchLotNumber: string | null; lotNumber: string; expiration: string; beyondUseDate: string };

// Compact, spreadsheet-like styling — same numbers as the Ordering page
// (V-T-ordering-lots-round3: "Make it much more compact ... same as
// Ordering: 2px 6px padding, 13px, thin borders").
const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1100 },
  button: { padding: "0.3rem 0.7rem", fontSize: "13px" },
  error: { color: "#b00020", fontSize: "0.75rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#8a5300", fontSize: "0.8rem", fontStyle: "italic" },
  // table-layout: fixed (V-lots-status-column) — column widths come from
  // the <colgroup> below and never get recomputed from a row's content,
  // which is what let the status column's Saving…/Saved ✓/error text
  // reflow the whole table before.
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "13px", lineHeight: 1.2, tableLayout: "fixed" as const },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  thRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  // Dedicated trailing status column (blank header) — always present so
  // Saving…/Saved ✓/an error never changes any other column's width or
  // the row's height. Fixed width + nowrap + ellipsis: a long error
  // message truncates instead of wrapping (full text in the title
  // tooltip).
  statusTh: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const, width: "7rem" },
  statusTd: {
    textAlign: "right" as const,
    padding: "2px 6px",
    borderBottom: "1px solid #eee",
    whiteSpace: "nowrap" as const,
    width: "7rem",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
  },
  savedText: { color: "#1a7f37", fontSize: "0.8rem", transition: "opacity 300ms ease-out" },
  statusError: { color: "#b00020", fontSize: "0.75rem" },
  // V-lots-row-status: the trailing status column's idle-state note text
  // for a row with no lot on file, or a lot but no expiration date
  // (both amber, matching styles.note's existing amber tone) vs. one
  // whose earliest set date is in the past (red, matching
  // styles.statusError's existing red).
  statusMissing: { color: "#8a5300", fontSize: "0.75rem" },
  statusExpired: { color: "#b00020", fontSize: "0.75rem" },
  // Darkened heading (matches Ordering — Will, 2026-09-09: "Darken the
  // heading color to make it easier to distinguish").
  groupRow: { background: "#d9dde3", fontWeight: 600 },
  inactiveRow: { color: "#999" },
  // V-lots-collapse-inactive: the collapsed Inactive <details>/<summary>
  // — styled the same dark/bold tone as styles.groupRow's <tr> so it
  // reads as the same kind of section heading, just collapsible. Native
  // <details> has no closed/open modifier we can key off in a plain
  // style object, so the ▸/▾ indicator is rendered as its own text
  // (see renderInactiveSummaryLabel) rather than via a ::marker/[open]
  // CSS selector.
  inactiveDetails: { marginTop: 0 },
  inactiveSummary: {
    cursor: "pointer",
    listStyle: "none" as const,
    background: "#d9dde3",
    fontWeight: 600,
    padding: "2px 6px",
    fontSize: "13px",
    userSelect: "none" as const,
  },
  // V-T-lots-round4 (Will verbatim: "Decrease the size of the boxes to
  // match their content better. The date ones are far too long.") —
  // sized to content instead of stretching to the full <td>: a date is
  // always "MM/DD/YYYY" (10 chars) plus a little breathing room, a lot
  // number is free text but rarely runs past a dozen-odd characters.
  lotInput: { width: "14ch", padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  dateInput: { width: "13ch", padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  // V-lots-bud-30d-shortcut: wraps the beyond-use-date box + its "30d"
  // link so they lay out side by side, with no reflow when the link is
  // clicked (the box's own width/border don't change, only its value).
  budDateWrap: { display: "inline-flex", alignItems: "center", gap: "0.3rem", whiteSpace: "nowrap" as const },
  // De-emphasized link-style button, not a bordered/background button
  // like styles.button, so it reads as a shortcut rather than a primary
  // action next to the date box.
  budShortcutLink: {
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    color: "#555",
    fontSize: "0.75rem",
    textDecoration: "underline",
    cursor: "pointer",
    flexShrink: 0,
  },
  // V-lots-row-status (Will 2026-09-14 verbatim: "If a lot is missing,
  // highlight the row in yellow. If it's expired, highlight it in red.")
  // — background only; text stays the default color for readability.
  missingRow: { background: "#fff8d6" },
  expiredRow: { background: "#fde2e2" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  // ⚙ settings menu — a native <details>/<summary> disclosure. Native
  // <details> does NOT close itself on an outside click, so a document
  // pointerdown listener (armed only while any menu is open — same
  // pattern as app/top-nav.tsx's account menu) closes every open
  // .lots-cog-menu whose element doesn't contain the click, plus
  // Escape. See anyMenuOpen/handleCogMenuToggle below.
  menuDetails: { display: "inline-block", position: "relative" as const },
  menuSummary: { cursor: "pointer", listStyle: "none" as const, padding: "0 4px", border: "1px solid #ccc", borderRadius: 3 },
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
    minWidth: 170,
    whiteSpace: "nowrap" as const,
  },
  menuItem: { display: "block", padding: "0.2rem 0", fontSize: "13px" },
  menuItemButton: { display: "block", width: "100%", textAlign: "left" as const, padding: "0.2rem 0", fontSize: "13px", background: "none", border: "none", cursor: "pointer", color: "#b00020" },
} as const;

// V-T-ordering-lots-round4 (Will: "autosave anytime new typing occurs")
// — how long a row's fields must sit idle before an autosave fires.
const AUTOSAVE_DEBOUNCE_MS = 600;

// V-lots-collapse-inactive: persists whether the Inactive section is
// expanded across reloads, per-browser (not synced server-side — purely
// a local display preference).
const INACTIVE_OPEN_STORAGE_KEY = "vaccine-assist:lots:inactiveOpen";

/** Reads the saved Inactive-section open/closed preference — defaults to
 * false (collapsed) whenever localStorage is unavailable/throws (private
 * browsing, disabled storage, SSR) or simply has nothing saved yet. */
function loadInactiveOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(INACTIVE_OPEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persists the Inactive-section open/closed preference — a write
 * failure (private browsing, storage disabled/full) is silently ignored;
 * losing the remembered preference isn't worth surfacing an error over. */
function persistInactiveOpenPreference(open: boolean) {
  try {
    window.localStorage.setItem(INACTIVE_OPEN_STORAGE_KEY, open ? "true" : "false");
  } catch {
    // ignore — see doc comment above
  }
}

export default function LotsPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineOption[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  // The draft snapshot as last confirmed PERSISTED (loaded from the
  // server, or a successful autosave) — compared against the live
  // `drafts` entry by lib/lots-autosave.ts's decide* functions to tell
  // "changed since last save" from "debounce refired with nothing new."
  const [lastSaved, setLastSaved] = useState<Record<string, RowDraft>>({});
  // Raw MM/DD/YYYY-in-progress display text per date field, from
  // DateTextInput's onRawTextChange — needed for the autosave decision
  // (decideDateAutosave), since draft.expiration/beyondUseDate only ever
  // hold a complete ISO value or "", collapsing "still typing" and
  // "8 digits but not a real date" into the same value.
  const [rawDateText, setRawDateText] = useState<Record<string, { expiration: string; beyondUseDate: string }>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [beyondUseDateSupported, setBeyondUseDateSupported] = useState(true);
  const [budEnabledKeys, setBudEnabledKeys] = useState<Set<string>>(new Set());

  // V-lots-collapse-inactive: collapsed by default (false) on the very
  // first render (matches server-rendered markup, avoiding a hydration
  // mismatch), then hydrated from localStorage once mounted — see the
  // effect below.
  const [inactiveOpen, setInactiveOpen] = useState(false);

  // V-T-ordering-lots-round4: no more explicit Save button, so more than
  // one row can be mid-autosave at once (e.g. tabbing quickly through
  // several rows) — keyed by productKey rather than a single "the one row
  // currently saving" string.
  const [savingByKey, setSavingByKey] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // V-lots-status-column: "visible" right after a successful autosave,
  // "fading" ~1.2s later (triggers the opacity transition on
  // styles.savedText), then removed entirely at ~1.5s — see flashSaved
  // below. Absence of a key means no flash is showing for that row.
  const [savedFlashByKey, setSavedFlashByKey] = useState<Record<string, "visible" | "fading">>({});

  const [activeBusyKey, setActiveBusyKey] = useState<string | null>(null);
  const [activeErrorByKey, setActiveErrorByKey] = useState<Record<string, string>>({});
  const [budBusyKey, setBudBusyKey] = useState<string | null>(null);
  const [budErrorByKey, setBudErrorByKey] = useState<Record<string, string>>({});

  // V-T-lots-ux-round3 (Will verbatim: "Popup if there is an error") —
  // any autosave/clear-lot/settings failure also raises a toast here,
  // in addition to the inline red row-error text that stays put.
  const { toasts, pushError, dismiss } = useErrorToasts();

  // V-T-lots-ux-round3 (Will verbatim: "on the settings menu for each
  // item, if you click off the menu, hide the menu"): true whenever at
  // least one row's ⚙ <details> is open — only while true is the
  // document pointerdown/keydown listener below armed (see effect).
  const [anyMenuOpen, setAnyMenuOpen] = useState(false);

  // Review follow-up (reviewer, 2026-09-10): runAutosave used to read
  // `drafts`/`lastSaved`/`rawDateText`/`budEnabledKeys` straight from
  // component state, closed over at whatever render happened to be
  // current when scheduleAutosave's setTimeout was ARMED — one render
  // behind the very keystroke that armed it, since that keystroke's own
  // setDrafts/setRawDateText hadn't committed yet. Only the LAST-armed
  // timer per row ever survives to fire, so this silently dropped the
  // final keystroke of any typing burst before a pause (e.g. "LOT2026A"
  // autosaved as "LOT2026"). These refs are kept in sync SYNCHRONOUSLY at
  // every state-mutation call site below (not via a useEffect, which
  // would still be timing-dependent) — runAutosave reads from `.current`
  // instead, so it always sees the value as of when it actually RUNS, not
  // as of when the timer that led to it was scheduled.
  const draftsRef = useRef<Record<string, RowDraft>>({});
  const lastSavedRef = useRef<Record<string, RowDraft>>({});
  const rawDateTextRef = useRef<Record<string, { expiration: string; beyondUseDate: string }>>({});
  const budEnabledKeysRef = useRef<Set<string>>(new Set());

  // Autosave bookkeeping (refs, not state — purely internal timing/
  // race-guard plumbing that should never itself trigger a re-render):
  //  - autosaveRunnersRef: one lib/lots-autosave.ts createDebouncedRunner
  //    per row (productKey), reused across keystrokes so scheduling a new
  //    debounce correctly cancels that SAME row's pending one.
  //  - autosaveSeqRef: a per-row counter bumped on every autosave attempt
  //    AND on Clear lot, so a response that lands after a newer attempt
  //    (or after the row's lot was cleared) is recognized as stale and
  //    ignored — "ignore stale responses, latest write wins."
  //  - autosaveInFlightRef: true while a row's request is in flight, so a
  //    debounce/blur that fires while one is already running re-arms the
  //    timer instead of firing a second, racing request for the same row.
  const autosaveRunnersRef = useRef<Record<string, DebouncedRunner>>({});
  const autosaveSeqRef = useRef<Record<string, number>>({});
  const autosaveInFlightRef = useRef<Record<string, boolean>>({});

  // Per-row "Saved ✓" flash timers (fade-then-remove) — see flashSaved.
  const savedFlashTimersRef = useRef<Record<string, { fade: ReturnType<typeof setTimeout>; remove: ReturnType<typeof setTimeout> }>>({});

  // Review follow-up (reviewer, 2026-09-10): with no cleanup, typing in a
  // Lot #/date field and then navigating away from /lots before the
  // ~600ms debounce elapsed left that row's pending timer armed — it
  // still fired after unmount, running a real fetch and then calling
  // setState (setSavingByKey/setRowErrors/etc., inside runAutosave) on an
  // unmounted component. Cancel every row's pending timer on unmount.
  useEffect(() => {
    return () => {
      for (const runner of Object.values(autosaveRunnersRef.current)) runner.cancel();
      for (const timers of Object.values(savedFlashTimersRef.current)) {
        clearTimeout(timers.fade);
        clearTimeout(timers.remove);
      }
    };
  }, []);

  // Closes every open ⚙ menu on an outside click/tap, and on Escape —
  // reuses the exact pattern from app/top-nav.tsx's account menu, just
  // over the (potentially many) `.lots-cog-menu` <details> elements
  // instead of a single ref. Only armed while anyMenuOpen is true.
  useEffect(() => {
    if (!anyMenuOpen) return;

    function closeMenusNotContaining(target: Node | null) {
      let stillOpen = false;
      document.querySelectorAll<HTMLDetailsElement>(".lots-cog-menu").forEach((el) => {
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

  /** Wired to each row's ⚙ <details onToggle>` — recomputes anyMenuOpen
   * from the live DOM rather than tracking per-row open state, since any
   * number of rows can have their menu open at once. */
  function handleCogMenuToggle() {
    const stillOpen = Array.from(document.querySelectorAll<HTMLDetailsElement>(".lots-cog-menu")).some(
      (el) => el.open
    );
    setAnyMenuOpen(stillOpen);
  }

  // V-lots-collapse-inactive: hydrate the remembered open/closed
  // preference once mounted (see inactiveOpen's own doc comment above
  // for why this isn't just the initial useState value).
  useEffect(() => {
    setInactiveOpen(loadInactiveOpenPreference());
  }, []);

  /** Wired to the Inactive section's <details onToggle> — persists the
   * new state alongside updating it so a reload remembers it. */
  function handleInactiveToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open;
    setInactiveOpen(open);
    persistInactiveOpenPreference(open);
  }

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setDrafts({});
    draftsRef.current = {};
    setLastSaved({});
    lastSavedRef.current = {};
    setRawDateText({});
    rawDateTextRef.current = {};
    setLoadError(null);
    setActiveErrorByKey({});
    setBudErrorByKey({});
    setBudEnabledKeys(new Set());
    budEnabledKeysRef.current = new Set();
    setSavingByKey({});
    setRowErrors({});
    for (const runner of Object.values(autosaveRunnersRef.current)) runner.cancel();
    autosaveRunnersRef.current = {};
    autosaveSeqRef.current = {};
    autosaveInFlightRef.current = {};
    for (const timers of Object.values(savedFlashTimersRef.current)) {
      clearTimeout(timers.fade);
      clearTimeout(timers.remove);
    }
    savedFlashTimersRef.current = {};
    setSavedFlashByKey({});
  }

  /** Cancels a row's pending fade/remove timers (a fresh save superseding
   * a still-fading flash, a Clear lot, or sign-out) without touching
   * savedFlashByKey itself — callers set that separately. */
  function clearSavedFlashTimers(key: string) {
    const timers = savedFlashTimersRef.current[key];
    if (!timers) return;
    clearTimeout(timers.fade);
    clearTimeout(timers.remove);
    delete savedFlashTimersRef.current[key];
  }

  /** Shows this row's "Saved ✓" status-column flash: visible immediately,
   * starts a ~300ms opacity fade at 1.2s, fully removed at 1.5s (Will:
   * "'Saved' that fades out after ~1.5s"). Re-entrant — a save that lands
   * while a previous flash is still fading just restarts the window. */
  function flashSaved(key: string) {
    clearSavedFlashTimers(key);
    setSavedFlashByKey((prev) => ({ ...prev, [key]: "visible" }));
    const fade = setTimeout(() => {
      setSavedFlashByKey((prev) => ({ ...prev, [key]: "fading" }));
    }, 1200);
    const remove = setTimeout(() => {
      setSavedFlashByKey((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      delete savedFlashTimersRef.current[key];
    }, 1500);
    savedFlashTimersRef.current[key] = { fade, remove };
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

  /** One draft per PRODUCT view. The group's "current" lot is
   * pickCurrentActiveLot over its lots deduped by lot_number
   * (dedupeLotsByNumber) — the union of every dose vaccine_id's lots,
   * collapsed back to the single value that's actually shown/edited. */
  function draftsFromProducts(views: ProductView[], lotList: LotRow[]): Record<string, RowDraft> {
    const next: Record<string, RowDraft> = {};
    for (const view of views) {
      const groupVaccineIds = new Set(view.vaccineIds);
      const groupLots = lotList.filter((l) => groupVaccineIds.has(l.vaccine_id));
      const current = pickCurrentActiveLot(dedupeLotsByNumber(groupLots));
      next[view.productKey] = {
        matchLotNumber: current?.lot_number ?? null,
        lotNumber: current?.lot_number ?? "",
        expiration: current?.expiration ?? "",
        beyondUseDate: current?.beyond_use_date ?? "",
      };
    }
    return next;
  }

  /** Vaccines grouped into one row per product (lib/product-view.ts's
   * SHARED buildProductViews — the same helper /ordering uses, so
   * name/NDC/pkg-size/group render identically on both pages) —
   * recomputed whenever `vaccines` changes rather than kept as separate
   * state, so it can never drift out of sync with the vaccine list it's
   * derived from. */
  const productViews = useMemo(() => buildProductViews(vaccines), [vaccines]);

  /** Groups product views into COVID/Flu/Other ACTIVE sections (same
   * order lib/ordering-group.ts's Ordering-tab display already uses),
   * plus ONE flat, alphabetized list of every INACTIVE product regardless
   * of group — V-T-ordering-lots-round4, Will: "Filter inactives to the
   * bottom of the page" (replacing the previous round's per-group
   * inactive placement). See lib/lots-grouping.ts's
   * partitionProductsForLotsPage for the actual (unit-tested) logic. */
  const { sections: groupedActiveProducts, inactive: inactiveProducts } = useMemo(
    () => partitionProductsForLotsPage(productViews, ORDERING_GROUP_DISPLAY_ORDER),
    [productViews]
  );

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [vaccinesRes, lotsRes, settingsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/lots/settings", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const vaccinesData = await vaccinesRes.json();
      const lotsData = await lotsRes.json();

      if (!vaccinesRes.ok) {
        setLoadError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }
      if (!lotsRes.ok) {
        setLoadError(lotsData.error ?? "Could not load lots.");
        return;
      }

      const loadedVaccines: VaccineOption[] = (vaccinesData.vaccines ?? []).map(
        (v: { id: string; name: string; active: boolean; ndc: string | null }) => ({
          id: v.id,
          name: v.name,
          active: v.active,
          ndc: v.ndc ?? null,
        })
      );
      const loadedLots: LotRow[] = lotsData.lots ?? [];
      const loadedViews = buildProductViews(loadedVaccines);
      const loadedDrafts = draftsFromProducts(loadedViews, loadedLots);

      const loadedRawDateText = Object.fromEntries(
        Object.entries(loadedDrafts).map(([key, draft]) => [
          key,
          { expiration: isoToMaskedDate(draft.expiration), beyondUseDate: isoToMaskedDate(draft.beyondUseDate) },
        ])
      );

      setVaccines(loadedVaccines);
      setLots(loadedLots);
      setDrafts(loadedDrafts);
      draftsRef.current = loadedDrafts;
      // The freshly-loaded drafts ARE the last-saved snapshot (nothing's
      // been typed yet) — autosave compares future edits against this.
      setLastSaved(loadedDrafts);
      lastSavedRef.current = loadedDrafts;
      setRawDateText(loadedRawDateText);
      rawDateTextRef.current = loadedRawDateText;
      setBeyondUseDateSupported(lotsData.beyondUseDateSupported !== false);

      // BUD enablement is a secondary setting — a failure here doesn't
      // block the page from showing lots/vaccines, it just falls back to
      // "nothing enabled" (no BUD field editable) until the next reload.
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        const loadedBudKeys = new Set<string>(settingsData.budEnabledProductKeys ?? []);
        setBudEnabledKeys(loadedBudKeys);
        budEnabledKeysRef.current = loadedBudKeys;
      } else {
        setBudEnabledKeys(new Set());
        budEnabledKeysRef.current = new Set();
      }

      setRowErrors({});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load lots.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadAll(session.accessToken);
  }, [session, loadAll]);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
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

  function updateDraft(key: string, patch: Partial<RowDraft>) {
    setDrafts((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      draftsRef.current = next; // see draftsRef's own doc comment above
      return next;
    });
  }

  /** Mirrors DateTextInput's onRawTextChange into both state (so a
   * re-render, if any, reflects it) and rawDateTextRef (so runAutosave
   * reads it fresh regardless of which render's debounce timer fires) —
   * see rawDateTextRef's own doc comment above. */
  function updateRawDateText(key: string, patch: Partial<{ expiration: string; beyondUseDate: string }>) {
    setRawDateText((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      rawDateTextRef.current = next;
      return next;
    });
  }

  /** Lazily creates (and thereafter reuses) this row's debounce timer —
   * MUST be the same object across calls so a later schedule() correctly
   * cancels that row's earlier pending one (see
   * lib/lots-autosave.ts's createDebouncedRunner). `run` reads
   * everything it needs from the *Ref refs above at CALL time, so which
   * render happened to create this runner doesn't matter — only draftsRef
   * etc.'s value at the moment the timer actually fires does. */
  function getAutosaveRunner(view: ProductView): DebouncedRunner {
    const key = view.productKey;
    let runner = autosaveRunnersRef.current[key];
    if (!runner) {
      runner = createDebouncedRunner(() => void runAutosave(view), AUTOSAVE_DEBOUNCE_MS);
      autosaveRunnersRef.current[key] = runner;
    }
    return runner;
  }

  /** Resets/restarts a row's ~600ms-after-last-keystroke autosave timer —
   * called from every field's onChange, so typing in ANY of the row's
   * fields (lot #, expiration, beyond-use date) pushes the same shared
   * per-row debounce back out, and runAutosave (below) re-evaluates every
   * field once it settles. */
  function scheduleAutosave(view: ProductView) {
    getAutosaveRunner(view).schedule();
  }

  /** Flushes a row's pending debounced save immediately — wired to each
   * field's onBlur (Will's brief: "debounce ~600ms after the last
   * keystroke, also flush on blur"). */
  function flushAutosaveNow(view: ProductView) {
    getAutosaveRunner(view).flushNow();
  }

  /**
   * Autosave orchestrator for one product row (V-T-ordering-lots-round4,
   * Will: "make it autosave anytime new typing occurs, with date
   * validation happening on the date fields prior to saving"). Runs
   * lib/lots-autosave.ts's pure decide* functions against the row's
   * current draft vs. its last-persisted snapshot to decide whether
   * there's an eligible, changed field to send — a lot number that's
   * non-empty and different, or a date field that's a complete, valid
   * calendar date and different. `draft.lotNumber`/`draft.expiration`
   * must BOTH currently hold a usable value for the request to actually
   * fire (an incomplete/invalid date collapses draft.expiration to "" via
   * DateTextInput's own onChange contract, the same gate the old explicit
   * Save button relied on) — otherwise this is a silent no-op, not an
   * error, since the user may simply still be typing the other field.
   *
   * Reads `draft`/`saved`/raw date text/BUD-enablement from the *Ref
   * refs above, NOT from `drafts`/`lastSaved`/`rawDateText`/
   * `budEnabledKeys` state directly — this function is called from a
   * debounce timer that may fire long after the render that scheduled
   * it, and reading component state here would close over a stale
   * snapshot from THAT render (review follow-up, reviewer 2026-09-10 —
   * see draftsRef's doc comment above and lib/lots-autosave.ts's
   * createDebouncedRunner doc comment for the bug this fixes).
   *
   * Reuses the SAME POST (no lot yet) / PATCH (upsert against
   * matchLotNumber) fan-out calls the old Save button used. At most one
   * request is in flight per row at a time (autosaveInFlightRef) — a
   * debounce/blur firing while one is already running just re-arms the
   * timer instead of racing a second request for the same row — and a
   * per-row sequence number (autosaveSeqRef) makes a genuinely stale
   * response (e.g. the row's lot was cleared while this request was in
   * flight) a no-op instead of clobbering newer state: "ignore stale
   * responses, latest write wins."
   *
   * Blanking Lot # or Expiration (Will 2026-09-16 verbatim: "if I remove
   * something (lot or exp), it needs to be saved when I remove it ...
   * right now it's flagging that it's missing, but if I refresh with the
   * lot/exp blank, it's reloading the old lot") is handled specially:
   * lib/lots-autosave.ts's decide* functions report "clear" for an
   * explicit removal of a previously-saved value, but the two fields
   * DON'T behave the same way, per Will's same-day follow-up:
   *   - Lot # cleared: lot_number is a NOT NULL column
   *     (supabase/migrations/0001_init.sql) AND a lot with no number
   *     isn't a meaningful persisted state (lotRowStatus always reports
   *     'missing' regardless of any date field) — this reuses the same
   *     fan-out DELETE the ⚙ menu's "Clear lot" button always has (see
   *     clearCurrentLot below), removing the row entirely.
   *   - Expiration cleared (lot # left as-is): expiration IS nullable
   *     (supabase/migrations/0014_lots_nullable_expiration.sql, pending
   *     Will's apply) — Will wants "has a lot number, no expiration" to
   *     be its own real, persisted 'missing-expiration' state (see
   *     lib/lots-row-status.ts), so this goes through the NORMAL save
   *     branch below like any other field change, sending an explicit
   *     `expiration: null` (via `draft.expiration || null`, the same
   *     pattern beyond_use_date already used) rather than deleting
   *     anything.
   */
  async function runAutosave(view: ProductView) {
    if (!session) return;
    const key = view.productKey;

    if (autosaveInFlightRef.current[key]) {
      scheduleAutosave(view);
      return;
    }

    const draft = draftsRef.current[key];
    const saved = lastSavedRef.current[key];
    if (!draft || !saved) return;

    const rawText = rawDateTextRef.current[key] ?? {
      expiration: isoToMaskedDate(saved.expiration),
      beyondUseDate: isoToMaskedDate(saved.beyondUseDate),
    };

    const lotDecision = decideLotNumberAutosave(draft.lotNumber, saved.lotNumber);
    const expirationDecision = decideDateAutosave(rawText.expiration, isoToMaskedDate(saved.expiration));
    const budEnabledForThisProduct = budEnabledKeysRef.current.has(key);
    const beyondUseDecision = budEnabledForThisProduct
      ? decideDateAutosave(rawText.beyondUseDate, isoToMaskedDate(saved.beyondUseDate))
      : "unchanged";

    if (lotDecision === "clear" && saved.matchLotNumber) {
      autosaveInFlightRef.current[key] = true;
      try {
        await clearCurrentLot(view, saved.matchLotNumber);
      } finally {
        autosaveInFlightRef.current[key] = false;
      }
      return;
    }

    // A cleared expiration on an EXISTING lot is its own eligible change
    // (see this function's doc comment) — the row keeps its lot_number,
    // expiration goes to null via the normal save branch below. A
    // brand-new lot (no saved.matchLotNumber yet) still requires a real
    // expiration: POST /api/lots has no "create with no expiration" path
    // today, so hasRequiredFields only relaxes the expiration
    // requirement once there's an existing lot to update.
    const expirationCleared = expirationDecision === "clear" && !!saved.matchLotNumber;
    const hasEligibleChange =
      lotDecision === "save" ||
      expirationDecision === "save" ||
      expirationCleared ||
      beyondUseDecision === "save" ||
      beyondUseDecision === "clear";
    const hasRequiredFields = draft.lotNumber.trim().length > 0 && (draft.expiration !== "" || expirationCleared);
    if (!hasEligibleChange || !hasRequiredFields) return;

    const seq = (autosaveSeqRef.current[key] ?? 0) + 1;
    autosaveSeqRef.current[key] = seq;
    autosaveInFlightRef.current[key] = true;

    setSavingByKey((prev) => ({ ...prev, [key]: true }));
    setRowErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      const lotNumber = draft.lotNumber.trim();
      const response = await fetch("/api/lots", {
        method: saved.matchLotNumber ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(
          saved.matchLotNumber
            ? {
                vaccineIds: view.vaccineIds,
                matchLotNumber: saved.matchLotNumber,
                lot_number: lotNumber,
                // "" (cleared) -> null — expiration is nullable
                // (V-lots-clear-save follow-up); an update never omits
                // it (see hasRequiredFields above), so this is always
                // either a real ISO date or an explicit clear.
                expiration: draft.expiration || null,
                beyond_use_date: draft.beyondUseDate || null,
              }
            : {
                vaccine_ids: view.vaccineIds,
                lot_number: lotNumber,
                // Always non-blank here — hasRequiredFields still
                // requires a real expiration to CREATE a brand-new lot.
                expiration: draft.expiration,
                beyond_use_date: draft.beyondUseDate || null,
              }
        ),
      });
      const data = await response.json();

      if (autosaveSeqRef.current[key] !== seq) return; // superseded — ignore this stale response

      if (!response.ok) {
        const message = data.error ?? "Failed to save lot.";
        setRowErrors((prev) => ({ ...prev, [key]: message }));
        pushError(`Couldn't save lot info for ${view.displayName} — ${message}`);
        return;
      }

      if (data.beyondUseDateSupported === false) setBeyondUseDateSupported(false);

      const savedLots: LotRow[] = data.lots ?? [];
      const groupVaccineIds = new Set(view.vaccineIds);
      const oldLotNumber = saved.matchLotNumber;
      setLots((prev) => {
        const withoutOld = oldLotNumber
          ? prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === oldLotNumber))
          : prev;
        return [...withoutOld, ...savedLots];
      });

      const nextSaved: RowDraft = {
        matchLotNumber: lotNumber,
        lotNumber,
        expiration: draft.expiration,
        beyondUseDate: draft.beyondUseDate,
      };
      setLastSaved((prev) => {
        const next = { ...prev, [key]: nextSaved };
        lastSavedRef.current = next;
        return next;
      });
      // Only update matchLotNumber on the live draft — never overwrite
      // lotNumber/expiration/beyondUseDate here, in case the user kept
      // typing further changes while this request was in flight.
      setDrafts((prev) => {
        const next = { ...prev, [key]: { ...prev[key], matchLotNumber: lotNumber } };
        draftsRef.current = next;
        return next;
      });
      flashSaved(key);
    } catch (err) {
      if (autosaveSeqRef.current[key] !== seq) return;
      const message = err instanceof Error ? err.message : "Failed to save lot.";
      setRowErrors((prev) => ({ ...prev, [key]: message }));
      pushError(`Couldn't save lot info for ${view.displayName} — ${message}`);
    } finally {
      autosaveInFlightRef.current[key] = false;
      if (autosaveSeqRef.current[key] === seq) {
        setSavingByKey((prev) => ({ ...prev, [key]: false }));
      }
    }
  }

  /** Clears a product row's current lot across every dose vaccine_id at
   * once (DELETE /api/lots, vaccineIds + lot_number) — shared by the ⚙
   * menu's explicit "Clear lot" button (handleDeleteRow, below) AND
   * runAutosave's implicit clear when the user blanks Lot #/Expiration
   * and leaves the field (see runAutosave's own doc comment for why
   * blanking either field must DELETE rather than UPDATE: lot_number and
   * expiration are both NOT NULL columns, so there's no "empty" value to
   * persist — removing the row entirely is the only schema-valid way to
   * represent it, and is also exactly the 'missing' status a lot that was
   * never entered shows). On failure, leaves the caller's already-blank
   * draft as-is and surfaces the existing error toast (ErrorToast/
   * pushError) instead of reverting anything — never silently discards
   * what the user typed. */
  async function clearCurrentLot(view: ProductView, matchLotNumber: string) {
    if (!session) return;
    const key = view.productKey;

    // Cancel any pending autosave for this row and bump its sequence
    // number so an autosave response already in flight can't re-create
    // the lot this clear is about to remove.
    autosaveRunnersRef.current[key]?.cancel();
    autosaveSeqRef.current[key] = (autosaveSeqRef.current[key] ?? 0) + 1;
    clearSavedFlashTimers(key);
    setSavedFlashByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

    setSavingByKey((prev) => ({ ...prev, [key]: true }));
    setRowErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      const response = await fetch("/api/lots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ vaccineIds: view.vaccineIds, lot_number: matchLotNumber }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data.error ?? "Failed to clear lot.";
        setRowErrors((prev) => ({ ...prev, [key]: message }));
        pushError(`Couldn't clear lot for ${view.displayName} — ${message}`);
        return;
      }

      const groupVaccineIds = new Set(view.vaccineIds);
      setLots((prev) => prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === matchLotNumber)));
      const cleared: RowDraft = { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" };
      setDrafts((prev) => {
        const next = { ...prev, [key]: cleared };
        draftsRef.current = next;
        return next;
      });
      setLastSaved((prev) => {
        const next = { ...prev, [key]: cleared };
        lastSavedRef.current = next;
        return next;
      });
      setRawDateText((prev) => {
        const next = { ...prev, [key]: { expiration: "", beyondUseDate: "" } };
        rawDateTextRef.current = next;
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to clear lot.";
      setRowErrors((prev) => ({ ...prev, [key]: message }));
      pushError(`Couldn't clear lot for ${view.displayName} — ${message}`);
    } finally {
      setSavingByKey((prev) => ({ ...prev, [key]: false }));
    }
  }

  /** The ⚙ menu's "Clear lot" action (renamed from "Delete lot",
   * V-T-ordering-lots-round4 — label only, behavior unchanged). Only ever
   * called when draft.matchLotNumber is set (button is disabled
   * otherwise) — nothing to clear for a product with no lot yet. */
  async function handleDeleteRow(view: ProductView) {
    const draft = drafts[view.productKey];
    if (!draft?.matchLotNumber) return;
    await clearCurrentLot(view, draft.matchLotNumber);
  }

  /** PATCH /api/vaccines/{id} {active} on EVERY dose vaccine_id in the
   * product — looped client-side (same per-vaccine endpoint the desktop
   * Active-vaccines tab already uses). Optimistic local update with
   * revert-on-failure, matching runAutosave's own busy/error pattern. */
  async function handleToggleActive(view: ProductView, nextActive: boolean) {
    if (!session) return;
    setActiveBusyKey(view.productKey);
    setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: "" }));
    try {
      const responses = await Promise.all(
        view.vaccineIds.map((vaccineId) =>
          fetch(`/api/vaccines/${vaccineId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
            body: JSON.stringify({ active: nextActive }),
          }).then(async (response) => ({ response, data: await response.json() }))
        )
      );
      const failed = responses.find(({ response }) => !response.ok);
      if (failed) {
        const message = failed.data.error ?? "Failed to update.";
        setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: message }));
        pushError(`Couldn't update active status for ${view.displayName} — ${message}`);
        return;
      }
      const groupVaccineIds = new Set(view.vaccineIds);
      setVaccines((prev) => prev.map((v) => (groupVaccineIds.has(v.id) ? { ...v, active: nextActive } : v)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update.";
      setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: message }));
      pushError(`Couldn't update active status for ${view.displayName} — ${message}`);
    } finally {
      setActiveBusyKey(null);
    }
  }

  /** PUT /api/lots/settings with this product's key added/removed from
   * the enabled list — optimistic local update on success, matching
   * handleToggleActive's own pattern. */
  async function handleToggleBud(view: ProductView, nextEnabled: boolean) {
    if (!session) return;
    setBudBusyKey(view.productKey);
    setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: "" }));
    const nextKeys = nextEnabled
      ? Array.from(new Set([...budEnabledKeys, view.productKey]))
      : Array.from(budEnabledKeys).filter((key) => key !== view.productKey);
    try {
      const response = await fetch("/api/lots/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ budEnabledProductKeys: nextKeys }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data.error ?? "Failed to update.";
        setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: message }));
        pushError(`Couldn't update beyond-use date setting for ${view.displayName} — ${message}`);
        return;
      }
      const confirmedKeys = new Set<string>(data.budEnabledProductKeys ?? nextKeys);
      setBudEnabledKeys(confirmedKeys);
      budEnabledKeysRef.current = confirmedKeys;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update.";
      setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: message }));
      pushError(`Couldn't update beyond-use date setting for ${view.displayName} — ${message}`);
    } finally {
      setBudBusyKey(null);
    }
  }

  /** "30d" shortcut next to a row's beyond-use-date box (Will 2026-09-24
   * verbatim: "add a 30d little link ... that sets the BUD to 30 days
   * from today") — sets that row's beyond-use date to 30 days from the
   * browser's local date and pushes it through the SAME autosave path a
   * typed date goes through, so it persists identically.
   *
   * Writes draftsRef/rawDateTextRef directly (a plain synchronous
   * assignment) rather than only going through updateDraft/
   * updateRawDateText's setState-updater form, then calls
   * flushAutosaveNow in the SAME tick: runAutosave (via
   * createDebouncedRunner's flushNow, see lib/lots-autosave.ts) reads
   * those refs synchronously before its first await, and a setState
   * updater function isn't guaranteed to have run by then. Every other
   * caller of updateDraft/updateRawDateText schedules or flushes from a
   * later, separate browser event (a debounce timer firing, or a
   * subsequent blur), so React has always committed by the time those
   * read the refs — this is the one caller that reads them back in the
   * same synchronous call stack that just wrote them, so it can't rely on
   * that same timing.
   */
  function handleBudShortcut(view: ProductView) {
    const key = view.productKey;
    const iso = plusDaysIso(new Date(), 30);
    const masked = isoToMaskedDate(iso);

    const nextDrafts = { ...draftsRef.current, [key]: { ...draftsRef.current[key], beyondUseDate: iso } };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);

    const nextRawDateText = {
      ...rawDateTextRef.current,
      [key]: { ...rawDateTextRef.current[key], beyondUseDate: masked },
    };
    rawDateTextRef.current = nextRawDateText;
    setRawDateText(nextRawDateText);

    flushAutosaveNow(view);
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to manage lots."
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

  const today = todayInChicago();

  function renderProductRow(view: ProductView) {
    const draft = drafts[view.productKey] ?? { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" };
    const rowError = rowErrors[view.productKey];
    const saving = !!savingByKey[view.productKey];
    const activeError = activeErrorByKey[view.productKey];
    const activeBusy = activeBusyKey === view.productKey;
    const budError = budErrorByKey[view.productKey];
    const budBusy = budBusyKey === view.productKey;
    const budEnabledForThisProduct = budEnabledKeys.has(view.productKey);
    const savedFlash = savedFlashByKey[view.productKey];

    // V-lots-row-status: inactive products never get the missing/expired
    // highlight or note (same "inactive wins" reasoning the old due-row
    // highlight used) — an inactive product isn't in rotation, so a lot
    // it happens to have on file is no longer actionable.
    const rowStatus = view.active
      ? lotRowStatus({ lotNumber: draft.lotNumber, expiration: draft.expiration, beyondUseDate: draft.beyondUseDate, today })
      : "ok";
    const expiredOn = view.active
      ? lotRowExpiredOn({ lotNumber: draft.lotNumber, expiration: draft.expiration, beyondUseDate: draft.beyondUseDate, today })
      : null;

    const status = rowStatusLabel({
      saving,
      justSaved: !!savedFlash,
      error: rowError || null,
      rowStatus,
      expiredOnDisplay: expiredOn ? isoToMaskedDate(expiredOn) : null,
    });

    const rowStyle = !view.active
      ? styles.inactiveRow
      : rowStatus === "expired"
        ? styles.expiredRow
        : rowStatus === "missing" || rowStatus === "missing-expiration"
          ? styles.missingRow
          : undefined;

    return (
      <tr key={view.productKey} style={rowStyle}>
        <td style={styles.td}>{view.displayName}</td>
        <td style={styles.td}>{formatNdcDashed(view.ndc) || "—"}</td>
        <td style={styles.tdRight}>{view.packageSize ?? "—"}</td>
        <td style={styles.td}>
          <input
            style={styles.lotInput}
            type="text"
            aria-label={`${view.displayName} lot number`}
            value={draft.lotNumber}
            onChange={(e) => {
              updateDraft(view.productKey, { lotNumber: e.target.value });
              scheduleAutosave(view);
            }}
            onBlur={() => flushAutosaveNow(view)}
          />
        </td>
        <td style={styles.td}>
          <DateTextInput
            value={draft.expiration}
            ariaLabel={`${view.displayName} expiration`}
            onChange={(value) => {
              updateDraft(view.productKey, { expiration: value });
              scheduleAutosave(view);
            }}
            onRawTextChange={(text) => updateRawDateText(view.productKey, { expiration: text })}
            onBlur={() => flushAutosaveNow(view)}
            onInvalidBlur={(message) =>
              pushError(`Invalid data entry — Expiration for ${view.displayName}: ${message}`)
            }
            style={styles.dateInput}
          />
        </td>
        {beyondUseDateSupported && (
          <td style={styles.td}>
            {budEnabledForThisProduct ? (
              <span style={styles.budDateWrap}>
                <DateTextInput
                  value={draft.beyondUseDate}
                  ariaLabel={`${view.displayName} beyond-use date`}
                  onChange={(value) => {
                    updateDraft(view.productKey, { beyondUseDate: value });
                    scheduleAutosave(view);
                  }}
                  onRawTextChange={(text) => updateRawDateText(view.productKey, { beyondUseDate: text })}
                  onBlur={() => flushAutosaveNow(view)}
                  onInvalidBlur={(message) =>
                    pushError(`Invalid data entry — Beyond-use date for ${view.displayName}: ${message}`)
                  }
                  style={styles.dateInput}
                />
                <button
                  type="button"
                  style={styles.budShortcutLink}
                  aria-label="Set beyond-use date to 30 days from today"
                  onClick={() => handleBudShortcut(view)}
                >
                  30d
                </button>
              </span>
            ) : (
              <span style={styles.muted}>—</span>
            )}
          </td>
        )}
        <td style={styles.td}>
          <details className="lots-cog-menu" style={styles.menuDetails} onToggle={handleCogMenuToggle}>
            <summary style={styles.menuSummary} aria-label={`${view.displayName} settings`}>
              ⚙
            </summary>
            <div style={styles.menuPanel}>
              <label style={styles.menuItem}>
                <input
                  type="checkbox"
                  aria-label={`${view.displayName} active`}
                  checked={view.active}
                  disabled={activeBusy}
                  onChange={(e) => void handleToggleActive(view, e.target.checked)}
                />{" "}
                Active
              </label>
              {beyondUseDateSupported && (
                <label style={styles.menuItem}>
                  <input
                    type="checkbox"
                    aria-label={`${view.displayName} show beyond-use date`}
                    checked={budEnabledForThisProduct}
                    disabled={budBusy}
                    onChange={(e) => void handleToggleBud(view, e.target.checked)}
                  />{" "}
                  Show beyond-use date
                </label>
              )}
              <button
                type="button"
                style={styles.menuItemButton}
                onClick={() => void handleDeleteRow(view)}
                disabled={saving || !draft.matchLotNumber}
              >
                Clear lot
              </button>
              {activeError && <div style={styles.error}>{activeError}</div>}
              {budError && <div style={styles.error}>{budError}</div>}
            </div>
          </details>
        </td>
        <td
          style={styles.statusTd}
          title={status?.kind === "error" || status?.kind === "expired" ? status.text : undefined}
        >
          {status?.kind === "saving" && <span style={styles.muted}>Saving…</span>}
          {status?.kind === "saved" && (
            <span style={{ ...styles.savedText, opacity: savedFlash === "fading" ? 0 : 1 }}>Saved ✓</span>
          )}
          {status?.kind === "error" && <span style={styles.statusError}>{status.text}</span>}
          {status?.kind === "expired" && <span style={styles.statusExpired}>{status.text}</span>}
          {status?.kind === "missing" && <span style={styles.statusMissing}>{status.text}</span>}
          {status?.kind === "missing-expiration" && <span style={styles.statusMissing}>{status.text}</span>}
        </td>
      </tr>
    );
  }

  /** The shared column widths both the active table and the (separate,
   * V-lots-collapse-inactive) inactive table render — kept in exactly one
   * place so the two <table>s' columns can never drift out of alignment
   * with each other. See table-layout: fixed's own doc comment above. */
  function renderLotsColgroup() {
    return (
      <colgroup>
        <col />
        <col style={{ width: "8rem" }} />
        <col style={{ width: "5.5rem" }} />
        <col style={{ width: "9rem" }} />
        <col style={{ width: "8.5rem" }} />
        {/* V-lots-bud-30d-shortcut: widened from 8.5rem so the "30d" link
            fits beside the date box without wrapping to a second line. */}
        {beyondUseDateSupported && <col style={{ width: "11rem" }} />}
        <col style={{ width: "3rem" }} />
        <col style={{ width: "7rem" }} />
      </colgroup>
    );
  }

  return (
    <main style={styles.main}>
      <ErrorToast toasts={toasts} onDismiss={dismiss} />
      <h1>Lots</h1>

      {!beyondUseDateSupported && (
        <p style={styles.note}>Beyond-use date isn&apos;t available yet on this environment (pending migration).</p>
      )}

      {loadError && <p style={styles.error}>{loadError}</p>}

      <table style={styles.table}>
        {/* table-layout: fixed columns — see the doc comment above and
            styles.table/statusTh/statusTd for why: nothing here may ever
            resize based on a row's content (that was the whole bug). */}
        {renderLotsColgroup()}
        <thead>
          <tr>
            <th style={styles.th}>Product</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.thRight}>Units/pkg</th>
            <th style={styles.th}>Lot #</th>
            <th style={styles.th}>Expiration</th>
            {beyondUseDateSupported && <th style={styles.th}>Beyond-use date</th>}
            <th style={styles.th}></th>
            <th style={styles.statusTh}></th>
          </tr>
        </thead>
        <tbody>
          {groupedActiveProducts.map(({ group, products }) => (
            <Fragment key={group}>
              <tr style={styles.groupRow}>
                <td style={styles.td}>{group}</td>
                <td style={styles.td}>—</td>
                <td style={styles.tdRight}>—</td>
                <td style={styles.td}>—</td>
                <td style={styles.td}>—</td>
                {beyondUseDateSupported && <td style={styles.td}>—</td>}
                <td style={styles.td}></td>
                <td style={styles.statusTd}></td>
              </tr>
              {products.map(renderProductRow)}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* V-lots-collapse-inactive: ONE collapsed Inactive section for the
          whole page, after every active group — a native <details> can't
          validly wrap <tr>s inside the table above's own <tbody>, so this
          is a SECOND <table> (same renderLotsColgroup widths) living
          inside the <details>, collapsed by default. */}
      {inactiveProducts.length > 0 && (
        <details className="lots-inactive-section" style={styles.inactiveDetails} open={inactiveOpen} onToggle={handleInactiveToggle}>
          <summary style={styles.inactiveSummary}>
            {inactiveOpen ? "▾" : "▸"} {formatInactiveSummaryLabel(inactiveProducts.length)}
          </summary>
          <table style={styles.table}>
            {renderLotsColgroup()}
            <tbody>{inactiveProducts.map(renderProductRow)}</tbody>
          </table>
        </details>
      )}
    </main>
  );
}
