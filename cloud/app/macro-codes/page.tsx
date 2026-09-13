"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import {
  buildMacroCode,
  buildMacroRows,
  DEFAULT_MACRO_VIEW_MODE,
  filterMacroTopGroups,
  groupMacroRowsBySection,
  groupSectionsByTopGroup,
  macroProductNameWithAge,
  macroSectionDisplayName,
  readMacroViewMode,
  writeMacroViewMode,
  type MacroDoseButton,
  type MacroLotLike,
  type MacroProductGroup,
  type MacroRow,
  type MacroRowVaccine,
  type MacroSection,
  type MacroSectionGroup,
  type MacroTopGroupBlock,
  type MacroViewMode,
  type MacroViewModeStorage,
} from "@/lib/macro-codes";
import { formatNdcDisplay } from "@/lib/lots-grouping";
import { postToHost } from "@/lib/macro-embed";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

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
 *   dose buttons ("Dose 1"/"Dose 2", or "Copy" for a single-dose
 *   product — see doseButtonShortLabel below).
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
 */

type VaccineRow = MacroRowVaccine;
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string; status: string };

type SectionColors = { bg: string; border: string; text: string };

/** One hue per section (Will's brief: "Colors: one hue per SECTION...
 * readable text, subtle (light background + darker border/text)").
 * Every MacroSection has an explicit entry so the palette is fully
 * deterministic — no runtime hashing/cycling logic to get wrong. */
const SECTION_COLORS: Readonly<Record<MacroSection, SectionColors>> = {
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

/** Round 8: switcher button labels, verbatim per Will's brief ("Make
 * the two different versions and add buttons at the top for me to
 * switch between them"). */
const VIEW_MODE_OPTIONS: readonly { mode: MacroViewMode; label: string }[] = [
  { mode: "A", label: "A · Type | buttons" },
  { mode: "B", label: "B · Type | product | dose" },
  { mode: "C", label: "C · Scan grid" },
];

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "0.75rem 1rem", maxWidth: "100%" },
  heading: { margin: "0 0 0.4rem", fontSize: "1.15rem" },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  // Round 6: three top-level groups ("COVID/Flu" | "Common" | "Other"),
  // one per column — see .macro-groups / .macro-group-column in the
  // <style> tag below for the layout/responsive rules.
  groups: { display: "flex", gap: "1.5rem", alignItems: "flex-start" },
  groupColumn: { flex: "1 1 0", minWidth: 0 },
  groupHeading: {
    fontSize: "1rem",
    fontWeight: 800,
    margin: "0 0 0.35rem",
    paddingBottom: "0.15rem",
    borderBottom: "2px solid #999",
  },
  copyFallback: { margin: "0.15rem 0 0.4rem", width: "100%" },
  copyFallbackInput: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.8rem",
    width: "100%",
    padding: "2px 4px",
    boxSizing: "border-box" as const,
    border: "1px solid #b00020",
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
  // Round 8: the A/B/C layout switcher + version C's live-filter box —
  // both sit above .macro-groups, so they use the same plain-object
  // convention as everything else here (hover/active states for the
  // switcher buttons are in the <style> tag below, same posture as the
  // dose buttons).
  viewSwitcher: { display: "flex", gap: "0.4rem", flexWrap: "wrap" as const, margin: "0 0 0.6rem" },
  filterBox: { margin: "0 0 0.6rem", maxWidth: 320 },
  filterInput: {
    width: "100%",
    padding: "0.4rem 0.6rem",
    fontSize: "13px",
    border: "1px solid #999",
    borderRadius: 5,
    boxSizing: "border-box" as const,
  },
} as const;

/** "Copied ✓" is 8 characters — a button's reserved width is at least
 * that (plus a little breathing room) so swapping the label to the
 * copied flag never shifts layout, per Will's brief ("'Copied ✓'
 * feedback on the button for 1.5s without layout shift"). */
const COPIED_FLAG = "Copied ✓";
const MIN_BUTTON_CH = COPIED_FLAG.length + 1;

/** Copies text via the Clipboard API, falling back to a hidden
 * textarea + execCommand for non-secure (http, non-localhost) contexts
 * where navigator.clipboard is unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
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

/** Read-only, auto-selected text field shown when copyToClipboard
 * returns false — the code is still visible/selectable so a manual
 * Cmd/Ctrl+C still works even though the programmatic copy didn't. */
function CopyFallback({ code }: { code: string }) {
  return (
    <p style={styles.copyFallback}>
      <span style={styles.error}>Couldn&apos;t copy — select and copy manually:</span>
      <br />
      <input
        type="text"
        readOnly
        autoFocus
        value={code}
        style={styles.copyFallbackInput}
        onFocus={(e) => e.currentTarget.select()}
      />
    </p>
  );
}

function missingNote(row: MacroRow): string | null {
  if (row.complete || row.shortCode === null) return null;
  const missingLot = !row.lotNumber;
  const missingExp = !row.expirationIso;
  if (missingLot && missingExp) return "lot + exp missing";
  if (missingLot) return "lot missing";
  if (missingExp) return "exp missing";
  return null;
}

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

  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineRow[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // Round 8: A/B/C layout switcher + version C's live-filter query.
  // viewMode starts at the default and is corrected from localStorage in
  // an effect (below) rather than a useState lazy initializer, so the
  // very first render — which also runs during SSR, where there's no
  // `window` — never touches storage and always matches between server
  // and client (no hydration mismatch); the stored choice, if any, then
  // takes over a frame later.
  const [viewMode, setViewModeState] = useState<MacroViewMode>(DEFAULT_MACRO_VIEW_MODE);
  const [filterQuery, setFilterQuery] = useState("");

  // Embed mode always renders as layout C (Will's brief: "layout C
  // forced") without touching `viewMode` itself, so the read/write-to-
  // localStorage effects below keep running exactly as they do outside
  // embed mode — the user's stored non-embed preference is preserved,
  // just ignored for what THIS render shows.
  const effectiveViewMode: MacroViewMode = embed ? "C" : viewMode;

  function getViewModeStorage(): MacroViewModeStorage | null {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    setViewModeState(readMacroViewMode(getViewModeStorage()));
  }, []);

  function setViewMode(mode: MacroViewMode) {
    setViewModeState(mode);
    writeMacroViewMode(getViewModeStorage(), mode);
  }

  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setLoadError(null);
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

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [vaccinesRes, lotsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers }),
        fetch("/api/lots", { headers }),
      ]);
      const [vaccinesData, lotsData] = await Promise.all([vaccinesRes.json(), lotsRes.json()]);

      if (!vaccinesRes.ok) {
        setLoadError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }
      if (!lotsRes.ok) {
        setLoadError(lotsData.error ?? "Could not load lots.");
        return;
      }

      setVaccines(vaccinesData.vaccines ?? []);
      setLots(lotsData.lots ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load macro codes.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refetchLots = useCallback(async (token: string) => {
    const response = await fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (response.ok) setLots(data.lots ?? []);
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

  // Version C's live filter only narrows what's shown in version C —
  // switching to A/B always shows the full catalog regardless of a
  // query typed while on C.
  const visibleTopGroups = useMemo(
    () => (effectiveViewMode === "C" ? filterMacroTopGroups(topGroups, filterQuery) : topGroups),
    [effectiveViewMode, topGroups, filterQuery]
  );

  function rowKey(row: MacroRow): string {
    return `${row.productKey}:${row.doseNumber}`;
  }

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
          postToHost({ type: "vaccine-assist:macro-copied", code: row.macro, label, product: row.displayName });
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
        postToHost({ type: "vaccine-assist:macro-copied", code: finalCode, label: modal.label, product: modal.row.displayName });
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
   *   version B/C's short "Dose 1"/"Copy" — see doseButtonShortLabel
   *   below) while every click/copy/modal/tooltip/title still uses the
   *   full descriptive label underneath, unchanged.
   * - `block`: version A's one-per-line vertical stack — full width,
   *   left-aligned text, instead of an inline pill sized to its label.
   * - `large`: version C's bigger hit target (Will's brief: "larger hit
   *   targets").
   * The click handler, disabled state, "Copied ✓" swap, missing-lot/exp
   * red dot, and copy-failure fallback are untouched from round 7.
   */
  function renderDoseButton(
    dose: MacroDoseButton,
    colors: SectionColors,
    options?: { visibleLabel?: string; block?: boolean; large?: boolean }
  ) {
    const { row, label } = dose;
    const key = rowKey(row);
    const isNoShortCode = row.shortCode === null;
    const isCopied = copiedKey === key;
    const note = missingNote(row);
    const block = options?.block ?? false;
    const large = options?.large ?? false;
    const visibleText = isCopied ? COPIED_FLAG : options?.visibleLabel ?? label;

    return (
      <span
        key={key}
        style={{ position: "relative", display: block ? "block" : "inline-block", width: block ? "100%" : undefined }}
      >
        <button
          type="button"
          disabled={isNoShortCode}
          onClick={() => void handleCopy(row, label)}
          title={isNoShortCode ? "no short code set" : note ? note : `Copy ${label} macro code`}
          className="macro-dose-button"
          style={{
            border: `1px solid ${isNoShortCode ? "#ccc" : colors.border}`,
            background: isNoShortCode ? "#f2f2f2" : colors.bg,
            color: isNoShortCode ? "#888" : colors.text,
            borderRadius: 5,
            // Age is now part of the label (round 5), so labels run
            // longer — a fixed minHeight + horizontal-only padding keeps
            // every button a consistent, clearly-clickable ~32px tall
            // regardless of label length, instead of growing vertically.
            // Version C bumps this further (`large`) for bigger hit
            // targets per Will's brief.
            minHeight: large ? 38 : 32,
            padding: large ? "0 0.75rem" : "0 0.5rem",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: block ? "flex-start" : "center",
            fontSize: large ? "13px" : "12px",
            fontWeight: 600,
            cursor: isNoShortCode ? "default" : "pointer",
            width: block ? "100%" : undefined,
            minWidth: block ? undefined : `${Math.max(visibleText.length, MIN_BUTTON_CH)}ch`,
            textAlign: block ? "left" : "center",
            boxSizing: "border-box",
          }}
        >
          {visibleText}
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
        {copyFailure?.key === key && <CopyFallback code={copyFailure.code} />}
      </span>
    );
  }

  /** Version B/C's short dose-button label (Will's verbatim brief:
   * "Dose 1 button... for a single-dose product, one button — pick
   * either 'Copy' or the product's short code as its label and use that
   * choice consistently across the whole version, don't mix"). Chose
   * "Copy" over the raw short code: the product name + age is already
   * spelled out in its own column right next to the button (unlike
   * version A, where the button IS the only place the name appears), so
   * the button just needs to say what clicking it does. Used identically
   * by both version B and version C so the choice stays consistent
   * across every version that uses short labels. */
  function doseButtonShortLabel(row: MacroRow, doseCount: number): string {
    return doseCount > 1 ? `Dose ${row.doseNumber}` : "Copy";
  }

  function renderSettingsMenu(product: MacroProductGroup) {
    const realDoses = product.doses.filter((d) => d.row.shortCode !== null);
    if (realDoses.length === 0) return null;
    const ndc = formatNdcDisplay(realDoses[0].row.ndc);

    return (
      <details className="macro-settings-menu" style={styles.menuDetails} onToggle={handleSettingsMenuToggle}>
        <summary style={styles.menuSummary} aria-label={`${product.displayName} details`}>
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

  /**
   * Version A (Will's verbatim brief): "have the heading be in 1
   * column, then the buttons next to it stacked vertically." One row
   * PER SECTION/FAMILY (not per product) — a fixed-width family-name
   * cell (macroSectionDisplayName) next to a vertical stack of every
   * dose button belonging to that family, one button per line, full
   * label text unchanged ("Shingrix (Dose 1) (50+, 19+ IC)" etc., same
   * as round 7 — see doseButtonLabel in lib/macro-codes.ts). The ⚙ menu
   * still fires once per PRODUCT (same renderSettingsMenu as every other
   * version), placed once at the end of that product's own dose lines
   * rather than once per family — a family with two products still gets
   * two separate ⚙s, just both inside the one family row.
   */
  function renderSectionVersionA(section: MacroSectionGroup) {
    const colors = SECTION_COLORS[section.section];
    return (
      <div key={section.section} className="macro-family-row">
        <div className="macro-family-cell" style={{ color: colors.text, borderLeftColor: colors.border }}>
          {macroSectionDisplayName(section.section)}
        </div>
        <div className="macro-dose-stack">
          {section.products.map((product) => (
            <div key={product.productKey} className="macro-row macro-product-block">
              <div className="macro-dose-lines">{product.doses.map((dose) => renderDoseButton(dose, colors, { block: true }))}</div>
              <div className="macro-settings-cell">{renderSettingsMenu(product)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  /**
   * Version B (Will's verbatim brief): "another column after type (ex:
   * tdap), then product (ex Boostrix (with age range)) > Dose 1
   * button." One row PER PRODUCT, three columns: family name
   * (macroSectionDisplayName, repeated per row — same posture as the
   * original Excel sheet's own Type column, which repeated per row
   * too), product name + age as PLAIN TEXT (macroProductNameWithAge —
   * not a button, not clickable), then the dose buttons themselves
   * (doseButtonShortLabel: "Dose 1"/"Dose 2", or "Copy" for a single-
   * dose product). The ⚙ menu is unchanged, once per product.
   */
  function renderSectionVersionB(section: MacroSectionGroup) {
    const colors = SECTION_COLORS[section.section];
    return (
      <section key={section.section} className="macro-section macro-section-b">
        {section.products.map((product) => {
          const doseCount = product.doses.length;
          return (
            <div key={product.productKey} className="macro-row macro-row-b">
              <div className="macro-family-cell-b" style={{ color: colors.text }}>
                {macroSectionDisplayName(section.section)}
              </div>
              <div className="macro-product-name-cell">{macroProductNameWithAge(product)}</div>
              <div className="macro-dose-buttons-b">
                {product.doses.map((dose) => renderDoseButton(dose, colors, { visibleLabel: doseButtonShortLabel(dose.row, doseCount) }))}
              </div>
              <div className="macro-settings-cell">{renderSettingsMenu(product)}</div>
            </div>
          );
        })}
      </section>
    );
  }

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
    return (
      <section key={section.section} className="macro-section macro-section-c">
        <h2 className="macro-section-band" style={{ background: colors.border }}>
          {macroSectionDisplayName(section.section)}
        </h2>
        {section.products.map((product) => {
          const doseCount = product.doses.length;
          const price = formatCashPrice(product.cashPriceCents);
          const metaText = price ? `${product.ageBase} · ${price}` : product.ageBase;
          return (
            <div key={product.productKey} className="macro-row macro-row-c">
              <div className="macro-product-name-cell-c">
                <div className="macro-product-name-c">{product.displayName}</div>
                <div className="macro-product-meta-c">
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
                  renderDoseButton(dose, colors, { visibleLabel: doseButtonShortLabel(dose.row, doseCount), large: true })
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
    const renderSection =
      effectiveViewMode === "A" ? renderSectionVersionA : effectiveViewMode === "B" ? renderSectionVersionB : renderSectionVersionC;
    // ROUND 9: version C's columns size to content (a fixed basis, no
    // grow/shrink to fill the row) instead of A/B's flex:1-0-0 stretch —
    // see .macro-groups-c on the wrapping container below for the
    // matching max-width cap. Inline style wins over the CSS class for
    // the flex/minWidth shorthand, so this is done here rather than in
    // the <style> tag.
    const columnStyle =
      effectiveViewMode === "C" ? { ...styles.groupColumn, flex: "0 1 340px", minWidth: 320 } : styles.groupColumn;
    return (
      <div key={block.group} className="macro-group-column" style={columnStyle}>
        <h2 style={styles.groupHeading}>{block.group}</h2>
        {block.sections.map((section) => renderSection(section))}
      </div>
    );
  }

  return (
    <main style={embed ? { ...styles.main, padding: "0.35rem 0.5rem" } : styles.main}>
      {!embed && <h1 style={styles.heading}>Macro codes</h1>}

      {!embed && (
        <div className="macro-view-switcher" style={styles.viewSwitcher} role="group" aria-label="Layout version">
          {VIEW_MODE_OPTIONS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className={`macro-view-switcher-button${viewMode === mode ? " active" : ""}`}
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {effectiveViewMode === "C" && (
        <div style={styles.filterBox}>
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
      )}

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}

      {!loading && (
        <div
          className={`macro-groups${effectiveViewMode === "C" ? " macro-groups-c" : ""}`}
          style={effectiveViewMode === "C" ? { ...styles.groups, maxWidth: 1200 } : styles.groups}
        >
          {visibleTopGroups.map((block) => renderTopGroup(block))}
        </div>
      )}

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
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>
              Enter lot / exp for {modal.row.displayName} dose {modal.row.doseNumber}
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
       * `embed` is true. */}
      <style>{`
        ${embed ? "nav[data-top-nav] { display: none !important; } body { background: #fff !important; }" : ""}
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

        /* View switcher */
        .macro-view-switcher-button {
          padding: 0.3rem 0.7rem;
          font-size: 12px;
          font-weight: 600;
          border: 1px solid #999;
          border-radius: 5px;
          background: #fff;
          color: #333;
          cursor: pointer;
        }
        .macro-view-switcher-button:hover { background: #f2f2f2; }
        .macro-view-switcher-button.active {
          background: #333;
          border-color: #333;
          color: #fff;
        }

        /* Version A: one row per family — fixed-width name cell next to
         * a vertical stack of every dose button in that family. */
        .macro-family-row {
          display: flex;
          align-items: flex-start;
          gap: 0.6rem;
          padding: 0.35rem 0;
          border-bottom: 1px solid #eee;
        }
        .macro-family-cell {
          flex: 0 0 92px;
          min-width: 0;
          font-size: 0.8rem;
          font-weight: 700;
          padding: 3px 0 3px 8px;
          border-left: 3px solid;
        }
        .macro-dose-stack {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .macro-product-block {
          display: flex;
          align-items: center;
          gap: 0.3rem;
        }
        .macro-dose-lines {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        /* Version B: family | product-name-plain-text | dose buttons | ⚙ */
        .macro-row-b {
          display: grid;
          grid-template-columns: 92px 1fr auto auto;
          align-items: center;
          gap: 0.5rem;
          padding: 3px 0;
          border-bottom: 1px solid #eee;
        }
        .macro-family-cell-b {
          font-size: 0.78rem;
          font-weight: 700;
        }
        .macro-product-name-cell {
          font-size: 0.85rem;
          min-width: 0;
        }
        .macro-dose-buttons-b {
          display: flex;
          gap: 0.25rem;
          flex-wrap: wrap;
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
        .macro-row-c {
          display: grid;
          grid-template-columns: 1fr auto auto;
          align-items: center;
          gap: 0.5rem;
          padding: 6px 0;
          border-bottom: 1px solid #eee;
        }
        .macro-product-name-cell-c {
          min-width: 0;
        }
        .macro-product-name-c {
          font-size: 15px;
          font-weight: 700;
          line-height: 1.25;
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
          gap: 0.3rem;
          justify-content: flex-end;
        }

        @media (max-width: 700px) {
          .macro-row-b, .macro-row-c {
            grid-template-columns: 1fr;
            justify-items: start;
          }
          .macro-dose-buttons-c { justify-content: flex-start; }
        }
      `}</style>
    </main>
  );
}
