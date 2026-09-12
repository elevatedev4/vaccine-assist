"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { computeOrderPackages } from "@/lib/vaccine-product-catalog";
import { deriveProductViewFields } from "@/lib/product-view";
import { computeHeadingTotals } from "@/lib/ordering-heading-totals";
import { formatNdcDashed } from "@/lib/ndc";
import { formatSurplus, surplusVsTarget } from "@/lib/ordering-recommendation";
import { buildToOrderRows } from "@/lib/ordering-to-order";
import { formatReloadDosesHistoryResult, type ReloadDosesHistoryResult } from "@/lib/ordering-reload-doses-history";

/**
 * Web edition of the desktop app's Ordering tab
 * (desktop/VaccineAssist.Desktop/Views/OrderingView.xaml +
 * ViewModels/OrderingViewModel.cs), rebuilt for V-ordering-targets
 * (Will 2026-09-08, msgs 904/908/909 + the V-T25 popup refinement) and
 * V-T26 (Will 2026-09-09):
 *   - one row per PRODUCT/NDC (a multi-dose series like Gardasil no
 *     longer shows 3 times — see GET /api/ordering/recommendation's NDC
 *     collapse)
 *   - rows grouped COVID / Flu / Other only (lib/ordering-group.ts —
 *     Ordering-tab-only coarsening; V-T26 item 5), bold group total rows
 *   - a per-row "Your target" override, autosaving on blur/Enter — the
 *     GROUP-level target input is REMOVED (V-T26 item 6: "Remove group
 *     target for now"; the API/lib behind it are untouched, just unused
 *     here) and a "Copy recommended → Your target" button batch-fills
 *     every active row's override from its recommended target (item 2)
 *   - a shared "Walk-up %" setting (V-T26 item 1) that adjusts the
 *     walk-in buffer baked into recommendedTarget/order server-side
 *   - Doses/pkg, Order (doses), Order (pkg) columns sourced from the
 *     static lib/vaccine-product-catalog.ts lookup (V-T26 item 7)
 *   - inactive vaccines collapsed into their own section below
 *   - a modal nudging staff to set up the daily on-hand EMAIL (shown
 *     until one has actually arrived — a manual upload doesn't count,
 *     see GET /api/on-hand/address's lastReceivedAt), plus an always-
 *     visible "Upload on-hand file" action in the settings menu
 *
 * V-ordering-layout-round3 (Will 2026-09-12, verbatim): "Make the To
 * Order table more succinct. Add a heading below it to separate the
 * full list of all vaccine BOH. Hide all those buttons at the top in a
 * settings cog or something. They're taking up way too much space." —
 * page-layout only, no changes to the recommendation math or API:
 *   - every former toolbar button/control (Refresh, Upload on-hand
 *     file, Copy recommended → Your target, Walk-up %, Email-in setup)
 *     now lives in a single ⚙ menu, top-right, same handlers unchanged
 *   - the "To order" table is trimmed to Product / NDC / Order qty / BOH
 *     with tighter row padding
 *   - "All vaccines — on hand, schedule, last 7 days given" heading now
 *     separates the To-order table from the full table below it
 */

type RecommendationRow = {
  key: string;
  vaccineName: string;
  ndc: string | null;
  group: string;
  active: boolean;
  upcoming7d: number;
  onHand: number | null;
  onHandAsOf: string | null;
  /** stock_size (+ unit recovered from raw_line, when present) of the
   * latest matched on-hand batch line for this product — e.g. "1 EA",
   * "0.5 ML" — or null when there's no on-hand row yet (V-onhand-ndc-units,
   * Will: "display unit size for each item, new column, after NDC").
   * Distinct from "Units/pkg" below (the catalog's static doses-per-
   * package figure): this is the per-BOH-unit size the Pioneer report
   * itself carries. */
  unitSize: string | null;
  /** Doses administered over the last 7 COMPLETE Chicago days, summed
   * across this product's own vaccine ids (V-ordering-trend, Will
   * 2026-09-12: "recommend that we keep up with the trends, since we
   * take walk-ins and not just schedule") — 0 when trendUnavailable is
   * true, or when nothing has been ingested for this product yet. */
  given7d: number;
  /** upcoming7d + its walk-in buffer — the schedule-driven demand
   * estimate (the OLD recommendedTarget formula, kept under its own
   * name now that a second estimate exists). */
  scheduledDemand: number;
  /** given7d itself, unbuffered — see lib/ordering-recommendation.ts's
   * computeDemandTarget doc comment for why no extra buffer is added. */
  trendDemand: number;
  /** max(scheduledDemand, trendDemand), before any "Your target"
   * override. */
  recommendedTarget: number;
  targetOnHand: number | null;
  effectiveTarget: number;
  /** Which estimate determined effectiveTarget: an NDC-scoped override,
   * or whichever of scheduledDemand/trendDemand was larger. */
  targetSource: "override" | "scheduled" | "trend";
  order: number;
};

type RecommendationResponse = {
  onHandLastReceivedAt: string | null;
  targetsPending: boolean;
  // V-T26 item 1: the effective walk-up % this response was computed
  // with, and whether that's still just the default (0012 pending).
  walkInPct: number;
  walkInPctPending: boolean;
  // V-ordering-trend: true when the route's administeredSummary call
  // failed — every row's given7d is 0 for this response, and the trend
  // estimate never wins a row's target while this is true. Shown as a
  // muted note under the table so staff know the trend column is stale/
  // unavailable rather than genuinely zero.
  trendUnavailable: boolean;
  // Still returned by the API (GET/PUT /api/ordering/targets and
  // lib/ordering-targets.ts are left intact per Will's brief), but this
  // page no longer reads or renders it — group-scoped overrides are
  // ignored server-side too (V-T26 item 6: "Remove group target for
  // now").
  groupTargets: Record<string, number>;
  rows: RecommendationRow[];
};

// V-onhand-account-address (Will 2026-09-08): the per-account on-hand
// email address — see GET /api/on-hand/address's RESPONSE CONTRACT.
// `lastReceivedAt` only ever reflects an actual EMAIL arriving (the
// upload route deliberately never touches it) — see the V-T25 popup
// logic below.
type OnHandAddressStatus =
  | { pending: true }
  | { pending?: false; address: string; token: string; lastReceivedAt: string | null; hasData: boolean };

type UploadResult = { inserted: number; unmatched: string[] };

const EMAIL_MODAL_DISMISSED_KEY = "ordering-email-setup-dismissed";

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1000 },
  toolbar: { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" as const, marginBottom: "0.5rem" },
  button: { padding: "0.5rem 1rem" },
  link: { fontSize: "0.85rem" },
  // Page header row (V-ordering-layout-round3, Will 2026-09-12: "Hide
  // all those buttons at the top in a settings cog... taking up way too
  // much space") — title on the left, the ⚙ actions menu pinned top-
  // right so the toolbar row no longer eats horizontal space.
  headerRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.5rem" },
  gearMenuWrap: { position: "relative" as const },
  gearButton: { fontSize: "1.1rem", lineHeight: 1, padding: "0.4rem 0.6rem", borderRadius: 6, border: "1px solid #888", background: "#fff", cursor: "pointer" },
  menuPanel: {
    position: "absolute" as const,
    top: "calc(100% + 6px)",
    right: 0,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
    padding: "0.6rem",
    minWidth: 280,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start" as const,
    gap: "0.5rem",
    zIndex: 50,
  },
  // Section heading separating the "To order" table from the full
  // vaccine list below it (V-ordering-layout-round3 item 3).
  sectionHeading: { marginTop: "2rem", marginBottom: "0.25rem" },
  // Succinct "To order" table cells (V-ordering-layout-round3 item 2):
  // smaller font + tighter padding than the main table's already-
  // compact styles.
  toOrderTh: { textAlign: "left" as const, padding: "1px 5px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const, fontSize: "12px" },
  toOrderThRight: { textAlign: "right" as const, padding: "1px 5px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const, fontSize: "12px" },
  toOrderTd: { textAlign: "left" as const, padding: "1px 5px", borderBottom: "1px solid #eee", fontSize: "12px", lineHeight: 1.15 },
  toOrderTdRight: { textAlign: "right" as const, padding: "1px 5px", borderBottom: "1px solid #eee", fontSize: "12px", lineHeight: 1.15 },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  muted: { color: "#555", fontSize: "0.875rem" },
  // Compact, spreadsheet-like table (V-T26 item 4, Will 2026-09-09):
  // tight cell padding, small font, tight line-height, thin 1px borders
  // throughout (no more 2px header rule), no extra row spacing.
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "13px", lineHeight: 1.2, marginTop: "0.75rem" },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  thRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  // Surplus column (V-ordering-surplus, Will 2026-09-11): BOH minus the
  // row's selected target — green when there's extra stock, red when
  // short, neutral (inherited color) exactly at target.
  tdRightSurplusPositive: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee", color: "#0a7d27" },
  tdRightSurplusNegative: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee", color: "#b00020" },
  // Order-quantity cells (Order (doses) / Order (pkg)) for any row with
  // something to order — light green fill + bold so a nonzero order can't
  // be scrolled past unnoticed.
  tdRightOrderDue: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee", background: "#e6f4ea", fontWeight: 700 },
  // Darkened (Will, 2026-09-09: "Darken the heading color to make it
  // easier to distinguish") from the original #f4f6f8, still light
  // enough for black text to stay readable.
  groupRow: { background: "#d9dde3", fontWeight: 600 },
  // Inputs sized to fit inside a compact cell — fixed ~64px width, thin
  // 1px border, no tall padding.
  targetInput: { width: 64, padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  walkInInput: { width: 48, padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  saveStatus: { fontSize: "0.7rem", marginLeft: "0.35rem" },
  // "Rec. target" cell's source label (V-ordering-trend) — small,
  // muted, superscript-positioned so it reads as a footnote on the
  // number rather than competing with it.
  targetSourceLabel: { fontSize: "0.65rem", color: "#666", marginLeft: "0.2rem", verticalAlign: "super" as const },
  inactiveToggle: { marginTop: "1.5rem", background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "0.4rem 0.75rem", cursor: "pointer" },
  // To-order table (V-T-ordering-unify, Will 2026-09-11): compact,
  // same look as the main table — the row itself is the "Copy NDC"
  // control (macro-codes'-page row-click-copy pattern), so its cells
  // stay plain styles.td/tdRight and the click affordance lives in the
  // .to-order-row <style> rule below.
  copyHint: { color: "#888", fontWeight: 400 as const },
  copiedFlag: { color: "#1a7f37", fontWeight: 600 },
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
    maxWidth: 480,
    width: "100%",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
  },
  codeBlock: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.9rem",
    background: "#f4f4f4",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.6rem 0.75rem",
    display: "inline-block",
    marginRight: "0.5rem",
    wordBreak: "break-all" as const,
  },
} as const;

// V-T26 item 3 (Will 2026-09-09): the per-cell "(as of <date>)" suffix
// is gone — the page-level "On-hand data last received" line
// (onHandStatusMessage below) already says when data arrived, so each
// cell just shows the number (or "no data yet").
function onHandDisplay(value: number | null): string {
  if (value === null) return "no data yet";
  return String(value);
}

function onHandStatusMessage(lastReceivedAt: string | null): string {
  return lastReceivedAt
    ? `On-hand data last received: ${new Date(lastReceivedAt).toLocaleString()}`
    : "On-hand data last received: never";
}

/** The "Surplus" cell's style + text for a row — green/red/neutral per
 * lib/ordering-recommendation.ts's surplusVsTarget, blank when unknown. */
function surplusCell(row: RecommendationRow): { style: CSSProperties; text: string } {
  const surplus = surplusVsTarget({ onHand: row.onHand, target: row.effectiveTarget });
  if (surplus === null) return { style: styles.tdRight, text: "" };
  if (surplus > 0) return { style: styles.tdRightSurplusPositive, text: formatSurplus(surplus) };
  if (surplus < 0) return { style: styles.tdRightSurplusNegative, text: formatSurplus(surplus) };
  return { style: styles.tdRight, text: formatSurplus(surplus) };
}

/** Order-quantity cell style: highlighted green+bold whenever this row has
 * something to order (V-ordering-surplus, Will: "so they don't get
 * missed"), else the plain right-aligned cell. */
function orderCellStyle(row: RecommendationRow): CSSProperties {
  return row.order > 0 ? styles.tdRightOrderDue : styles.tdRight;
}

/** The "Rec. target" cell's small source label (V-ordering-trend): "yours"
 * when a "Your target" override is in effect, "trend" when last week's
 * actual pace beat the scheduled+buffer estimate, and nothing when the
 * schedule-driven estimate itself won (the ordinary case) — Will's
 * brief: "nothing when scheduled". */
function targetSourceLabel(row: RecommendationRow): string | null {
  if (row.targetSource === "override") return "yours";
  if (row.targetSource === "trend") return "trend";
  return null;
}

/** A single "target on-hand" cell — a row's own NDC-scoped override
 * (V-T26 item 6 removed the group-header version of this control; the
 * group-header cell is now a plain "—" placeholder, see the render
 * below). Local editable text, autosaving on blur/Enter; an empty value
 * on save clears the override (PUT targetOnHand: null). */
function TargetInput({
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
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

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
        style={styles.targetInput}
        value={text}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      />
      {status === "saving" && <span style={styles.saveStatus}>saving…</span>}
      {status === "saved" && <span style={{ ...styles.saveStatus, color: "#0a7d27" }}>saved</span>}
      {status === "error" && <span style={{ ...styles.saveStatus, color: "#b00020" }}>error</span>}
    </span>
  );
}

function sortRows(rows: RecommendationRow[]): RecommendationRow[] {
  return [...rows].sort((a, b) => {
    if (a.order !== b.order) return b.order - a.order;
    return a.vaccineName.localeCompare(b.vaccineName);
  });
}

type EnrichedRow = RecommendationRow & {
  /** productName + (ageRange) when the static catalog
   * (lib/vaccine-product-catalog.ts) knows both, productName alone when
   * it knows the product but not its age range, else today's plain
   * vaccine name (V-T26 item 7). */
  displayName: string;
  /** The shared product-view's NDC: this row's own DB ndc when present,
   * else the researched catalog packageNdc (V-T-ordering-lots-round3,
   * Will: "Look up any missing NDCs" — products whose DB row has no NDC
   * on file, like Capvaxive/Flucelvax PFS/FluMist/mNEXSPIKE/Pneumovax
   * 23/Spikevax, now show their researched package NDC here instead of
   * "—"). Overrides (Your target) still key off row.ndc (the DB value),
   * unchanged. */
  displayNdc: string | null;
  /** Doses per package (rendered as "Units/pkg" in the table —
   * V-T-ordering-lots-round3, renamed from "Pkg size" V-onhand-ndc-units:
   * "Pkg size is now Units/pkg"), or null when the catalog has no row for
   * this product yet ("—" in the table). */
  dosesPerPackage: number | null;
  /** ceil(order / dosesPerPackage), or null when dosesPerPackage is
   * unknown ("—" in the table). */
  orderPackages: number | null;
};

/** Adds the Units/pkg + Order (pkg) + display-name/NDC fields to a
 * recommendation row, via the SHARED lib/product-view.ts lookup (same
 * fields the /lots page computes for the same product — V-T-ordering-
 * lots-round3) — pure/no I/O, so this can run per-row at render time. */
function enrichRow(row: RecommendationRow): EnrichedRow {
  const fields = deriveProductViewFields(row.vaccineName, row.ndc);
  return {
    ...row,
    displayName: fields.displayName,
    displayNdc: fields.ndc,
    dosesPerPackage: fields.packageSize,
    orderPackages: computeOrderPackages(row.order, fields.packageSize),
  };
}

export default function OrderingPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [addressStatus, setAddressStatus] = useState<OnHandAddressStatus | null>(null);
  const [addressStatusError, setAddressStatusError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  // V-ordering-reload-doses-history: ⚙ menu's "Reload doses history"
  // action — re-runs POST /api/administered/reprocess (re-reads every
  // retained Pioneer vaccination-log attachment) and reports the result
  // in the same banner area as the Upload action's own result/error.
  const [reloadingHistory, setReloadingHistory] = useState(false);
  const [reloadHistoryError, setReloadHistoryError] = useState<string | null>(null);
  const [reloadHistoryResult, setReloadHistoryResult] = useState<ReloadDosesHistoryResult | null>(null);

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);

  // V-ordering-layout-round3: the top-right ⚙ actions menu — closes on
  // an outside click (see the effect below), same as any ordinary
  // dropdown/popover.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // V-T26 item 1: the "Walk-up %" input's local editable text + save
  // status, same shape as TargetInput's own local state below but kept
  // inline here since it's a single page-level setting, not a per-row
  // control.
  const [walkInPctText, setWalkInPctText] = useState("");
  const [walkInPctStatus, setWalkInPctStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // V-T26 item 2: "Copy recommended → Your target" — a two-step
  // confirm (Will's brief: "small 'Overwrite existing Your targets?'
  // text with Yes/Cancel") since it overwrites every active NDC row's
  // override at once.
  const [copyConfirming, setCopyConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<{ count: number } | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  // To-order table (V-T-ordering-unify, Will 2026-09-11): which row's
  // NDC was just copied, for the 1.5s "Copied ✓" flash — same pattern
  // as app/macro-codes/page.tsx's copiedKey.
  const [copiedNdcKey, setCopiedNdcKey] = useState<string | null>(null);

  function resetAfterSignOut() {
    setData(null);
    setLoadError(null);
    setAddressStatus(null);
    setAddressStatusError(null);
    setUploading(false);
    setUploadError(null);
    setUploadResult(null);
    setAddressCopied(false);
    setReloadingHistory(false);
    setReloadHistoryError(null);
    setReloadHistoryResult(null);
    setShowEmailModal(false);
    setInactiveExpanded(false);
    setWalkInPctText("");
    setWalkInPctStatus("idle");
    setCopyConfirming(false);
    setCopying(false);
    setCopyResult(null);
    setCopyError(null);
    setCopiedNdcKey(null);
    setMenuOpen(false);
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

  // V-ordering-layout-round3: close the ⚙ menu on a click outside it.
  useEffect(() => {
    if (!menuOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [menuOpen]);

  const loadRecommendation = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/ordering/recommendation", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (!response.ok) {
        setLoadError(body.error ?? "Could not load ordering recommendations.");
        return;
      }
      setData(body as RecommendationResponse);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load ordering recommendations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadRecommendation(session.accessToken);
  }, [session, loadRecommendation]);

  // V-T26 item 1: keep the Walk-up % input's local text in sync with
  // the server's effective value whenever a fresh recommendation loads
  // (e.g. right after this or another browser tab saves a new value) —
  // same "sync local editable text from the prop" pattern as
  // TargetInput's own effect above, just inlined for this single field.
  useEffect(() => {
    if (data) setWalkInPctText(String(data.walkInPct));
  }, [data?.walkInPct]);

  const loadAddressStatus = useCallback(async (token: string) => {
    setAddressStatusError(null);
    try {
      const response = await fetch("/api/on-hand/address", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setAddressStatusError("Could not load the on-hand report email address.");
        return;
      }
      const body: OnHandAddressStatus = await response.json();
      setAddressStatus(body);
    } catch (err) {
      setAddressStatusError(err instanceof Error ? err.message : "Could not load the on-hand report email address.");
    }
  }, []);

  useEffect(() => {
    if (session) void loadAddressStatus(session.accessToken);
  }, [session, loadAddressStatus]);

  // V-T25: pop the "set up your daily email" modal automatically once we
  // know this account has never received an EMAIL (lastReceivedAt is
  // strictly about the email path — see the type comment above), unless
  // it was already dismissed this browser session.
  useEffect(() => {
    if (!addressStatus || ("pending" in addressStatus && addressStatus.pending)) return;
    if (addressStatus.lastReceivedAt !== null) {
      setShowEmailModal(false);
      return;
    }
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(EMAIL_MODAL_DISMISSED_KEY) === "1";
    } catch {
      // sessionStorage unavailable (private mode, etc.) — just show it.
    }
    if (!dismissed) setShowEmailModal(true);
  }, [addressStatus]);

  function handleCloseEmailModal() {
    setShowEmailModal(false);
    try {
      sessionStorage.setItem(EMAIL_MODAL_DISMISSED_KEY, "1");
    } catch {
      // Soft failure — the modal just won't remember being dismissed.
    }
  }

  async function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !session) return;

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/on-hand/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) {
        setUploadError(body.error ?? "Could not upload the file.");
        return;
      }
      setUploadResult(body as UploadResult);
      await Promise.all([loadAddressStatus(session.accessToken), loadRecommendation(session.accessToken)]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
      setUploading(false);
    }
  }

  // V-ordering-reload-doses-history: same auth/fetch pattern as the
  // recommendation fetch / on-hand upload above — bearer token, no
  // request body — then refresh the recommendation so "Last 7d given"
  // reflects whatever the reprocess just (re)loaded.
  async function handleReloadDosesHistory() {
    if (!session) return;
    setReloadingHistory(true);
    setReloadHistoryError(null);
    setReloadHistoryResult(null);
    try {
      const response = await fetch("/api/administered/reprocess", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const body = await response.json();
      if (!response.ok) {
        setReloadHistoryError(body.error ?? "Could not reload doses history.");
        return;
      }
      setReloadHistoryResult({ rows: body.rows, days: body.days, processed: body.processed });
      await loadRecommendation(session.accessToken);
    } catch (err) {
      setReloadHistoryError(err instanceof Error ? err.message : "Could not reload doses history.");
    } finally {
      setReloadingHistory(false);
    }
  }

  async function handleCopyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch {
      // Clipboard API unavailable/denied — the address is still visible
      // and selectable in the code box, so this is a soft failure.
    }
  }

  // To-order table row click/keyboard handler — clicking or pressing
  // Enter/Space anywhere on a row copies its NDC (digits-with-dashes,
  // as displayed), same "click anywhere on the row" pattern as
  // app/macro-codes/page.tsx's row copy. A row with no NDC on file has
  // nothing to copy, so it isn't made interactive at all (see the
  // toOrderRows.map render below).
  async function handleCopyOrderNdc(row: { key: string; ndc: string | null }) {
    if (!row.ndc) return;
    const text = formatNdcDashed(row.ndc);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedNdcKey(row.key);
      setTimeout(() => setCopiedNdcKey((current) => (current === row.key ? null : current)), 1500);
    } catch {
      // Clipboard API unavailable/denied — the NDC is still visible in
      // the cell, so this is a soft failure.
    }
  }

  function handleToOrderRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: { key: string; ndc: string | null }) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void handleCopyOrderNdc(row);
  }

  // Raw PUT /api/ordering/targets call with NO reload afterward — split
  // out from saveTarget below so handleCopyRecommended (V-T26 item 2)
  // can fire one PUT per row in a loop and reload the recommendation
  // ONCE at the end, instead of once per row.
  async function putTargetRequest(
    token: string,
    scope: "ndc" | "group",
    key: string,
    targetOnHand: number | null
  ): Promise<boolean> {
    try {
      const response = await fetch("/api/ordering/targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope, key, targetOnHand }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  const saveTarget = useCallback(
    async (scope: "ndc" | "group", key: string, targetOnHand: number | null): Promise<boolean> => {
      if (!session) return false;
      const ok = await putTargetRequest(session.accessToken, scope, key, targetOnHand);
      if (ok) await loadRecommendation(session.accessToken);
      return ok;
    },
    [session, loadRecommendation]
  );

  // V-T26 item 2: "Copy recommended → Your target" — sets every ACTIVE
  // product row's NDC-scoped override to its own recommendedTarget via
  // the existing PUT targets API (no batch endpoint exists, so this is
  // sequential — see putTargetRequest above). A row with no NDC has
  // nothing to save an override under (same rule TargetInput's own
  // `disabled={!row.ndc}` already enforces), so it's skipped, not
  // counted as a failure.
  async function handleCopyRecommended() {
    if (!session || !data) return;
    setCopying(true);
    setCopyError(null);
    setCopyResult(null);
    try {
      const activeRowsWithNdc = data.rows.filter((row) => row.active && row.ndc);
      let count = 0;
      for (const row of activeRowsWithNdc) {
        const ok = await putTargetRequest(session.accessToken, "ndc", row.ndc as string, row.recommendedTarget);
        if (ok) count += 1;
      }
      await loadRecommendation(session.accessToken);
      setCopyResult({ count });
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : "Could not copy targets.");
    } finally {
      setCopying(false);
      setCopyConfirming(false);
    }
  }

  // V-T26 item 1: save the Walk-up % setting on blur/Enter, same
  // autosave shape as TargetInput's own commit() below.
  async function handleSaveWalkInPct() {
    if (!session) return;
    const trimmed = walkInPctText.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setWalkInPctStatus("error");
      return;
    }
    if (data && parsed === data.walkInPct) {
      setWalkInPctStatus("idle");
      return;
    }
    setWalkInPctStatus("saving");
    try {
      const response = await fetch("/api/ordering/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ walkInPct: parsed }),
      });
      if (!response.ok) {
        setWalkInPctStatus("error");
        return;
      }
      setWalkInPctStatus("saved");
      setTimeout(() => setWalkInPctStatus((current) => (current === "saved" ? "idle" : current)), 2000);
      await loadRecommendation(session.accessToken);
    } catch {
      setWalkInPctStatus("error");
    }
  }

  function handleWalkInPctKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  }

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data: signInData, error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error || !signInData.session) {
        setSignInError(error?.message ?? "Sign-in failed.");
        return;
      }
      setSession(toSessionState(signInData.session));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  // V-T26 item 5 (Will 2026-09-09): COVID/Flu/Other only — the route
  // already emits `row.group` as one of exactly those three names
  // (lib/ordering-group.ts's getOrderingGroup), so this display order is
  // just those three, each appearing exactly once. This also fixes item
  // 8's "Other renders twice" bug: the OLD version of this array was
  // `[...GROUP_DISPLAY_ORDER, OTHER_GROUP]`, but GROUP_DISPLAY_ORDER
  // (lib/vaccine-group-catalog.ts) already ENDS with OTHER_GROUP, so
  // "Other" appeared twice in that array and its entire section
  // (including "Pfizer 3-4"/"Pfizer 5-11") rendered twice.
  const groupedActiveRows = useMemo(() => {
    if (!data) return [];
    const activeRows = data.rows.filter((row) => row.active);
    const byGroup = new Map<string, RecommendationRow[]>();
    for (const row of activeRows) {
      const list = byGroup.get(row.group);
      if (list) list.push(row);
      else byGroup.set(row.group, [row]);
    }
    const order = ORDERING_GROUP_DISPLAY_ORDER.filter((group) => byGroup.has(group));
    // Any group name not in the known display order (shouldn't happen —
    // the route only ever emits COVID/Flu/Other — but defensive) still
    // gets shown, appended at the end, at most once.
    for (const group of byGroup.keys()) {
      if (!order.includes(group)) order.push(group);
    }
    return order.map((group) => ({ group, rows: sortRows(byGroup.get(group) ?? []) }));
  }, [data]);

  const inactiveRows = useMemo(() => {
    if (!data) return [];
    return sortRows(data.rows.filter((row) => !row.active));
  }, [data]);

  // To-order table (V-T-ordering-unify, Will 2026-09-11): "a new table
  // at the top that shows only items recommended to be ordered" — every
  // ACTIVE row with order > 0, from lib/ordering-to-order.ts's pure
  // helper. Pre-filtered to active here (same as groupedActiveRows
  // above) so an inactive/discontinued product's leftover `order` can
  // never surface — buildToOrderRows also filters on `active` itself,
  // belt-and-suspenders (reviewer blocking fix, 2026-09-11).
  const toOrderRows = useMemo(() => buildToOrderRows((data?.rows ?? []).filter((row) => row.active)), [data]);

  // V-ordering-layout-round3 item 2: the To-order table's one context
  // column (BOH) — looked up by row key from the full recommendation
  // data rather than added to lib/ordering-to-order.ts's ToOrderRow
  // shape, since that lib is other coders' territory this round.
  const onHandByKey = useMemo(() => new Map((data?.rows ?? []).map((row) => [row.key, row.onHand] as const)), [data]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view ordering recommendations."
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

  const targetsPending = data?.targetsPending ?? false;
  const address = addressStatus && !("pending" in addressStatus && addressStatus.pending) ? addressStatus.address : null;
  const showEmailSetupLink =
    !!addressStatus && !("pending" in addressStatus && addressStatus.pending) && addressStatus.lastReceivedAt === null;

  // V-ordering-layout-round3: the status text that matters stays
  // visible (Will: "Keep... visible but compact — one line") — combined
  // into a single muted line instead of the two separate paragraphs the
  // toolbar round used to render.
  const statusParts: string[] = [];
  if (data) statusParts.push(onHandStatusMessage(data.onHandLastReceivedAt));
  if (data?.trendUnavailable) statusParts.push("Last-7-days-given trend unavailable — using scheduled estimate only.");

  const uploadControl = (
    <>
      <label style={{ ...styles.button, border: "1px solid #888", borderRadius: 4, cursor: uploading ? "default" : "pointer", display: "inline-block" }}>
        {uploading ? "Uploading…" : "Upload on-hand file"}
        <input
          type="file"
          accept=".xlsx,.csv,.txt,.pdf"
          onChange={(e) => void handleUploadFile(e)}
          disabled={uploading}
          style={{ display: "none" }}
        />
      </label>
    </>
  );

  return (
    <main style={styles.main}>
      <div style={styles.headerRow}>
        <h1 style={{ margin: 0 }}>Ordering recommendations</h1>
        <div style={styles.gearMenuWrap} ref={menuRef}>
          <button
            type="button"
            style={styles.gearButton}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-label="Ordering settings and actions"
            title="Settings and actions"
          >
            ⚙
          </button>
          {menuOpen && (
            <div style={styles.menuPanel} role="menu">
              <button style={styles.button} type="button" onClick={() => void loadRecommendation(session.accessToken)} disabled={loading}>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
              {uploadControl}
              <button style={styles.button} type="button" onClick={() => void handleReloadDosesHistory()} disabled={reloadingHistory}>
                {reloadingHistory ? "Reloading…" : "Reload doses history"}
              </button>
              {!copyConfirming ? (
                <button
                  style={styles.button}
                  type="button"
                  onClick={() => setCopyConfirming(true)}
                  disabled={!data || targetsPending}
                >
                  Copy recommended → Your target
                </button>
              ) : (
                <span style={styles.muted}>
                  Overwrite existing Your targets?{" "}
                  <button style={styles.button} type="button" onClick={() => void handleCopyRecommended()} disabled={copying}>
                    {copying ? "Copying…" : "Yes"}
                  </button>{" "}
                  <button style={styles.button} type="button" onClick={() => setCopyConfirming(false)} disabled={copying}>
                    Cancel
                  </button>
                </span>
              )}
              <span style={styles.muted}>
                <label htmlFor="walk-in-pct">Walk-up %</label>{" "}
                <input
                  id="walk-in-pct"
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  style={styles.walkInInput}
                  value={walkInPctText}
                  disabled={data?.walkInPctPending}
                  title={data?.walkInPctPending ? "saves after a 1-minute database step" : undefined}
                  onChange={(e) => setWalkInPctText(e.target.value)}
                  onBlur={() => void handleSaveWalkInPct()}
                  onKeyDown={handleWalkInPctKeyDown}
                />
                {walkInPctStatus === "saving" && <span style={styles.saveStatus}>saving…</span>}
                {walkInPctStatus === "saved" && <span style={{ ...styles.saveStatus, color: "#0a7d27" }}>saved</span>}
                {walkInPctStatus === "error" && <span style={{ ...styles.saveStatus, color: "#b00020" }}>error</span>}
                {data?.walkInPctPending && <span style={styles.saveStatus}>saves after a 1-minute database step</span>}
              </span>
              {showEmailSetupLink && (
                <a href="#" style={styles.link} onClick={(e) => { e.preventDefault(); setShowEmailModal(true); setMenuOpen(false); }}>
                  Email-in setup
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {addressStatusError && <p style={styles.error}>{addressStatusError}</p>}
      {uploadError && <p style={styles.error}>{uploadError}</p>}
      {reloadHistoryError && <p style={styles.error}>{reloadHistoryError}</p>}
      {copyError && <p style={styles.error}>{copyError}</p>}
      {copyResult && (
        <p style={styles.success}>
          Copied {copyResult.count} target{copyResult.count === 1 ? "" : "s"}.
        </p>
      )}
      {uploadResult && (
        <p style={styles.success}>
          Imported {uploadResult.inserted} row{uploadResult.inserted === 1 ? "" : "s"} (
          {uploadResult.inserted - uploadResult.unmatched.length} matched).
          {uploadResult.unmatched.length > 0 ? ` Unmatched: ${uploadResult.unmatched.join(", ")}.` : ""}
        </p>
      )}
      {reloadHistoryResult && <p style={styles.success}>{formatReloadDosesHistoryResult(reloadHistoryResult)}</p>}

      {statusParts.length > 0 && <p style={styles.muted}>{statusParts.join(" · ")}</p>}

      <h2>To order</h2>
      {toOrderRows.length === 0 ? (
        <p style={styles.muted}>Nothing to order</p>
      ) : (
        <table style={{ ...styles.table, marginTop: "0.5rem" }} className="to-order-table">
          <thead>
            <tr>
              <th style={styles.toOrderTh}>Product</th>
              <th style={styles.toOrderTh}>NDC</th>
              <th style={styles.toOrderThRight}>Order qty</th>
              <th style={styles.toOrderThRight}>BOH</th>
            </tr>
          </thead>
          <tbody>
            {toOrderRows.map((row) => {
              const ndcText = formatNdcDashed(row.ndc) || "—";
              const isCopied = copiedNdcKey === row.key;
              const canCopy = !!row.ndc;
              return (
                <tr
                  key={row.key}
                  className={canCopy ? "to-order-row" : undefined}
                  role={canCopy ? "button" : undefined}
                  tabIndex={canCopy ? 0 : undefined}
                  aria-label={canCopy ? `Copy ${row.displayName} NDC ${ndcText}` : undefined}
                  onClick={canCopy ? () => void handleCopyOrderNdc(row) : undefined}
                  onKeyDown={canCopy ? (e) => handleToOrderRowKeyDown(e, row) : undefined}
                >
                  <td style={styles.toOrderTd}>{row.displayName}</td>
                  <td style={styles.toOrderTd}>
                    {ndcText}
                    {canCopy && (isCopied ? <span style={{ ...styles.copiedFlag, marginLeft: "0.4rem" }}>Copied ✓</span> : <span style={{ ...styles.copyHint, marginLeft: "0.4rem" }}>Copy</span>)}
                  </td>
                  <td style={styles.toOrderTdRight}>
                    {row.orderPackages ?? `— (${row.order} dose${row.order === 1 ? "" : "s"})`}
                  </td>
                  <td style={styles.toOrderTdRight}>{onHandDisplay(onHandByKey.get(row.key) ?? null)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={styles.sectionHeading}>All vaccines — on hand, schedule, last 7 days given</h2>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.th}>Unit size</th>
            <th style={styles.thRight}>Units/pkg</th>
            <th style={styles.thRight}>7d</th>
            <th style={styles.thRight} title="Doses given in the last 7 complete days (from Pioneer's daily report)">
              Last 7d given
            </th>
            <th style={styles.thRight}>Rec. target</th>
            <th style={styles.th}>Target</th>
            <th style={styles.th}>BOH (doses)</th>
            <th style={styles.thRight} title="BOH minus target">Surplus</th>
            <th style={styles.thRight}>Order (doses)</th>
            <th style={styles.thRight}>Order (pkg)</th>
          </tr>
        </thead>
        <tbody>
          {groupedActiveRows.map(({ group, rows }) => {
            const enrichedRows = rows.map(enrichRow);
            // V-T-ordering-lots-round3 (Will 2026-09-09, verbatim): "Leave
            // off the targets for headings. Just leave the target and
            // order all blank on those rows." — see
            // lib/ordering-heading-totals.ts's doc comment. "Last 7d
            // given" (V-ordering-trend) joins that same left-off-on-
            // headings set, same reasoning.
            const totals = computeHeadingTotals(enrichedRows);

            return (
              <Fragment key={group}>
                <tr style={styles.groupRow}>
                  <td style={styles.td}>{group}</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>{totals.upcoming7d}</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.td}>{totals.onHand}</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>—</td>
                </tr>
                {enrichedRows.map((row) => {
                  const surplus = surplusCell(row);
                  const sourceLabel = targetSourceLabel(row);
                  return (
                    <tr key={row.key}>
                      <td style={{ ...styles.td, paddingLeft: "1.5rem" }}>{row.displayName}</td>
                      <td style={styles.td}>{formatNdcDashed(row.displayNdc) || "—"}</td>
                      <td style={styles.td}>{row.unitSize ?? "—"}</td>
                      <td style={styles.tdRight}>{row.dosesPerPackage ?? "—"}</td>
                      <td style={styles.tdRight}>{row.upcoming7d}</td>
                      <td style={styles.tdRight}>{row.given7d}</td>
                      <td style={styles.tdRight}>
                        {row.recommendedTarget}
                        {sourceLabel && <span style={styles.targetSourceLabel}>{sourceLabel}</span>}
                      </td>
                      <td style={styles.td}>
                        <TargetInput
                          value={row.targetOnHand}
                          disabled={targetsPending || !row.ndc}
                          disabledTitle={targetsPending ? "activates after the database step" : "no NDC on file for this product"}
                          onSave={(value) => (row.ndc ? saveTarget("ndc", row.ndc, value) : Promise.resolve(false))}
                        />
                      </td>
                      <td style={styles.td}>{onHandDisplay(row.onHand)}</td>
                      <td style={surplus.style}>{surplus.text}</td>
                      <td style={orderCellStyle(row)}>{row.order}</td>
                      <td style={orderCellStyle(row)}>{row.orderPackages ?? "—"}</td>
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {inactiveRows.length > 0 && (
        <>
          <button type="button" style={styles.inactiveToggle} onClick={() => setInactiveExpanded((v) => !v)}>
            {inactiveExpanded ? "▾" : "▸"} Inactive vaccines ({inactiveRows.length})
          </button>
          {inactiveExpanded && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Vaccine</th>
                  <th style={styles.th}>NDC</th>
                  <th style={styles.th}>Unit size</th>
                  <th style={styles.thRight}>Units/pkg</th>
                  <th style={styles.thRight}>7d</th>
                  <th style={styles.thRight} title="Doses given in the last 7 complete days (from Pioneer's daily report)">
                    Last 7d given
                  </th>
                  <th style={styles.thRight}>Rec. target</th>
                  <th style={styles.th}>BOH (doses)</th>
                  <th style={styles.thRight} title="BOH minus target">Surplus</th>
                  <th style={styles.thRight}>Order (doses)</th>
                  <th style={styles.thRight}>Order (pkg)</th>
                </tr>
              </thead>
              <tbody>
                {inactiveRows.map(enrichRow).map((row) => {
                  const surplus = surplusCell(row);
                  const sourceLabel = targetSourceLabel(row);
                  return (
                    <tr key={row.key}>
                      <td style={styles.td}>{row.displayName}</td>
                      <td style={styles.td}>{formatNdcDashed(row.displayNdc) || "—"}</td>
                      <td style={styles.td}>{row.unitSize ?? "—"}</td>
                      <td style={styles.tdRight}>{row.dosesPerPackage ?? "—"}</td>
                      <td style={styles.tdRight}>{row.upcoming7d}</td>
                      <td style={styles.tdRight}>{row.given7d}</td>
                      <td style={styles.tdRight}>
                        {row.recommendedTarget}
                        {sourceLabel && <span style={styles.targetSourceLabel}>{sourceLabel}</span>}
                      </td>
                      <td style={styles.td}>{onHandDisplay(row.onHand)}</td>
                      <td style={surplus.style}>{surplus.text}</td>
                      <td style={orderCellStyle(row)}>{row.order}</td>
                      <td style={orderCellStyle(row)}>{row.orderPackages ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {showEmailModal && address && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>Set up the daily on-hand email</h2>
            <p>
              <span style={styles.codeBlock}>{address}</span>
              <button style={styles.button} type="button" onClick={() => void handleCopyAddress(address)}>
                {addressCopied ? "Copied!" : "Copy"}
              </button>
            </p>
            <p style={styles.muted}>
              Point PioneerRx&apos;s daily on-hand report at this address.
              <br />
              Attach (or paste) the current-BOH export.
              <br />
              Reports arrive within a minute of being sent.
            </p>
            <p>
              <label style={{ ...styles.button, border: "1px solid #888", borderRadius: 4, cursor: uploading ? "default" : "pointer", display: "inline-block" }}>
                {uploading ? "Uploading…" : "Or upload a file now"}
                <input
                  type="file"
                  accept=".xlsx,.csv,.txt,.pdf"
                  onChange={(e) => void handleUploadFile(e)}
                  disabled={uploading}
                  style={{ display: "none" }}
                />
              </label>
            </p>
            {uploadError && <p style={styles.error}>{uploadError}</p>}
            <p style={{ textAlign: "right", marginBottom: 0 }}>
              <button style={styles.button} type="button" onClick={handleCloseEmailModal}>
                Close
              </button>
            </p>
          </div>
        </div>
      )}

      {/* To-order table row interaction (hover/focus affordance for the
       * click-to-copy row) — same "no external library" <style> posture
       * as app/macro-codes/page.tsx's row styling. */}
      <style>{`
        .to-order-table tbody tr.to-order-row { cursor: pointer; }
        .to-order-table tbody tr.to-order-row:hover,
        .to-order-table tbody tr.to-order-row:focus-visible {
          background: #f2f6fb;
          outline: none;
        }
      `}</style>
    </main>
  );
}
