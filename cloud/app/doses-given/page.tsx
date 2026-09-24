"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { getOrderingGroup } from "@/lib/ordering-group";
import {
  allRange,
  buildDosesGivenPivot,
  dosesGivenPivotToCsv,
  formatRangeSummary,
  orderProductsByGroup,
  productTotalsDescending,
  productTotalsToCsv,
  quickPickRange,
  visibleDayRows,
  type DosesGivenPivot,
  type QuickPickId,
} from "@/lib/doses-given";
import { vaccineDisplayName } from "@/lib/vaccine-display-name";

/**
 * Doses given explorer (V-doses-given, Will 2026-09-12 verbatim: "On the
 * scheduling page, include a data explorer link for doses given.") —
 * same look/pattern as the appointment Data Explorer
 * (app/appointments/explorer/page.tsx): a date-range picker, a pinned
 * loading bar, and CSV export. Data comes from GET
 * /api/administered/doses-given, which pivots lib/administered/store.ts's
 * per-day ingested dose rows into a day x product grid — see that
 * route's own doc comment. lib/doses-given.ts holds the pure pivot/CSV
 * logic (kept there, not inline here, same "pure + unit-tested" split
 * the explorer page's own doc comment describes for its own lib file).
 *
 * ROUND 2 (V-doses-given-layout, Will 2026-09-13, verbatim: "Seems to be
 * working generally, but make the formatting match our scheduling page
 * for consistency (without the green highlighting, just spacing and
 * arrangement-wise). And it's currently showing 376 doses, but my
 * reports in my software that I uploaded has 419 doses" — cause: the
 * page's ONLY default was a fixed last-14-days lookback, but the store
 * holds doses back to 8/4 including his 419-row upload):
 *   - Default range is now "earliest day on file through yesterday"
 *     (lib/doses-given.ts's allRange), fetched via a cheap
 *     `?earliestOnly=1` request BEFORE the main pivot fetch even fires
 *     (loadEarliestDayAndDefaultRange below) — see the route's own doc
 *     comment for why that path stays cheap. Falls back to the old
 *     14-day lookback only when nothing has been ingested yet.
 *   - Quick-pick buttons (All / Last 7 days / Last 14 days / This month)
 *     wired to lib/doses-given.ts's quickPickRange, applying immediately
 *     (no separate Apply click needed).
 *   - The "By day" table's look now mirrors the Schedule page's chart-
 *     style table (app/appointments/page.tsx) — compact fixed-width data
 *     columns, natural (not stretched) width, right-aligned numbers,
 *     bold totals, a COVID/Flu-first-then-everything-else grouped header
 *     with the SAME tint colors — minus that table's heatmap shading,
 *     per Will's explicit "without the green highlighting" ask. Column
 *     grouping/ordering is orderProductsByGroup (lib/doses-given.ts),
 *     which reuses lib/ordering-group.ts's COVID/Flu/Other classifier —
 *     the same one Ordering already runs product names through — rather
 *     than inventing a second scheme. Style objects/constants below are
 *     copied from app/appointments/page.tsx's styles/GROUP_COLORS/
 *     DATA_COL_WIDTH_PX/COLUMN_DIVIDER/formatDayLabel (none of those are
 *     exported from that file, so the values are duplicated here rather
 *     than imported).
 *   - The grand total now renders as a prominent headline ("527 doses ·
 *     8/4–9/11" — formatRangeSummary) above the tables.
 *
 * ROUND 3 (V-doses-given, Will 2026-09-13, verbatim: "We're closed on
 * sat/sun, so if there is no data on those days, then no need to show
 * them.") — the "By day" table now hides a Saturday/Sunday row whose
 * total is 0 (visibleDates below, from lib/doses-given.ts's
 * visibleDayRows). CSV export is unaffected — handleDownloadCsv reads
 * pivot.dates directly, so every day (including empty weekends) still
 * exports.
 *
 * ROUND 4 (V-doses-given-round6, Will, verbatim: "Make the doses-given be
 * listed in reverse daily order with the total at the bottom, so we can
 * see most recent days first at the top.") — the "By day" table's date
 * rows are now newest-first (lib/doses-given.ts's visibleDayRows reverses
 * after filtering, since pivot.dates arrives oldest-first). The Total row
 * was already the last row rendered in the tbody (after the visibleDates
 * map) — unaffected by this change, still at the bottom. CSV export is
 * unaffected — handleDownloadCsv still reads pivot.dates directly in its
 * original ascending order.
 *
 * ROUND 5 (V-doses-given, Will 2026-09-14 verbatim: "Move the total to
 * the top line on doses given, instead of bottom. Everything else looks
 * fine so far.") — the "By day" table's Total row now renders FIRST in
 * the tbody, directly under the header, followed by the newest-first day
 * rows from visibleDates — same bold styling, just moved. No total row
 * at the bottom anymore. The "By product" view's own Total row (a
 * different table) is unaffected. CSV export is unaffected — it still
 * appends Total as the trailing row (lib/doses-given.ts's
 * dosesGivenPivotToCsv), unrelated to this on-screen table's row order.
 */

type ViewMode = "byDay" | "byProduct";

// Copied from app/appointments/page.tsx (not exported there) — same
// fixed per-data-column pixel width so this table reads as chart-like
// and compact instead of stretching equal-width columns to fill a wide
// monitor (Will, V-T12: "Just make it take up the amount of space it
// should take up").
const DATA_COL_WIDTH_PX = 56;
const TOTAL_COL_WIDTH_PX = 60;

// Same COVID/Flu tint values as app/appointments/page.tsx's GROUP_COLORS
// (also not exported there); "Other" reuses that file's "Other" group
// tint since lib/ordering-group.ts's 3-bucket scheme collapses
// everything non-COVID/Flu into one group here, unlike the Schedule
// page's separate Common/Other split.
const GROUP_COLORS: Record<string, string> = {
  COVID: "#dbe7f9",
  Flu: "#f9e2cc",
  Other: "#e3daf3",
};

// Same "vertical border on every column" convention as
// app/appointments/page.tsx's COLUMN_DIVIDER (V-T9, Will: "I need
// vertical borders for the columns").
const COLUMN_DIVIDER = { borderLeft: "1px solid #c9c9c9" } as const;

const QUICK_PICKS: { id: QuickPickId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "last7", label: "Last 7 days" },
  { id: "last14", label: "Last 14 days" },
  { id: "thisMonth", label: "This month" },
];

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem", fontSize: "0.72rem" },
  heading: { margin: "0.5rem 0 0.5rem", fontSize: "1.25rem" },
  backLink: { fontSize: "0.8rem", margin: "0 0 0.75rem" },
  controlsRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "flex-end",
    gap: "0.9rem",
    margin: "0 0 0.5rem",
  },
  controlGroup: { display: "flex", flexDirection: "column" as const, gap: "0.2rem" },
  label: { fontWeight: 600, fontSize: "0.68rem", color: "#333" },
  input: { padding: "0.3rem 0.4rem", fontSize: "0.72rem", border: "1px solid #ccc", borderRadius: 3 },
  button: { padding: "0.35rem 0.8rem", fontSize: "0.72rem", cursor: "pointer" },
  toggleRow: { display: "flex", gap: "0.3rem", flexWrap: "wrap" as const },
  toggleButton: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #999",
    background: "#fff",
    cursor: "pointer",
    borderRadius: 4,
  },
  toggleButtonActive: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #1e6b3a",
    background: "#16a34a",
    color: "#fff",
    cursor: "pointer",
    borderRadius: 4,
    fontWeight: 600,
  },
  error: { color: "#b00020" },
  muted: { color: "#555", fontSize: "0.72rem" },
  // Prominent grand-total headline (Will: "Show the grand total
  // prominently") — sits above the tables, below the controls row.
  summary: { fontSize: "0.95rem", fontWeight: 700, margin: "0 0 0.6rem" },
  resultsAreaWrap: { position: "relative" as const },
  loadingOverlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    display: "flex",
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.8rem",
    background: "#fff",
    border: "1px solid #d5dce3",
    borderRadius: 6,
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
  },
  spinner: {
    width: "1.1rem",
    height: "1.1rem",
    borderRadius: "50%",
    border: "3px solid #d5dce3",
    borderTopColor: "#16a34a",
    animation: "doses-given-spin 0.7s linear infinite",
  },
  loadingLabel: { fontSize: "0.78rem", fontWeight: 600, color: "#333" },
  // Same "bare fallback only" table-wrap convention as
  // app/appointments/page.tsx's styles.tableWrap — the table sizes to
  // its own (compact) content, this only kicks in a scrollbar on a
  // viewport narrower than the table itself.
  tableWrap: { overflowX: "auto" as const, marginTop: "0.4rem" },
  // Compact chart-style table — same values as
  // app/appointments/page.tsx's styles.table/thType/thGroup/thLeaf/td/
  // tdZero/tdType/totalCell (copied, not imported — see this file's
  // header comment).
  table: { borderCollapse: "collapse" as const, fontSize: "0.72rem" },
  thType: {
    textAlign: "left" as const,
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap" as const,
  },
  thGroup: {
    textAlign: "center" as const,
    padding: "0.1rem 0.25rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 700,
    whiteSpace: "nowrap" as const,
  },
  thLeaf: {
    textAlign: "right" as const,
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    fontWeight: 500,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  td: { textAlign: "right" as const, padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee" },
  tdZero: { textAlign: "right" as const, padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", color: "#bbb" },
  tdType: { textAlign: "left" as const, padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 500 },
  totalCell: { textAlign: "right" as const, padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 700 },
  totalRowLabel: { textAlign: "left" as const, padding: "0.1rem 0.25rem", fontWeight: 700 },
  totalRow: { borderTop: "2px solid #ccc" },
} as const;

function groupHeaderStyle(group: string) {
  return { ...styles.thGroup, ...COLUMN_DIVIDER, background: GROUP_COLORS[group] ?? GROUP_COLORS.Other };
}

function leafHeaderStyle(group: string) {
  return { ...styles.thLeaf, ...COLUMN_DIVIDER, background: GROUP_COLORS[group] ?? GROUP_COLORS.Other };
}

function dataCellStyle(isZero: boolean) {
  return { ...(isZero ? styles.tdZero : styles.td), ...COLUMN_DIVIDER };
}

type GroupHeaderCell = { key: string; label: string; colSpan: number };
type LeafHeaderCell = { key: string; label: string; group: string };

/**
 * Groups an already-COVID/Flu-first-ordered product list (see
 * orderProductsByGroup, lib/doses-given.ts) into the 2-row nested header
 * the "By day" table renders — one spanning group cell per contiguous
 * run, then one leaf cell per product underneath. Simpler than the
 * Schedule page's buildHeaderRows (app/appointments/page.tsx): doses
 * given has no COVID-brand/age sub-level, just flat product names, so
 * there's no 3rd header row to build.
 */
function buildProductHeaderRows(orderedProducts: string[]): { groups: GroupHeaderCell[]; leaves: LeafHeaderCell[] } {
  const leaves: LeafHeaderCell[] = orderedProducts.map((product) => ({
    key: product,
    label: vaccineDisplayName(product),
    group: getOrderingGroup(product),
  }));

  const groups: GroupHeaderCell[] = [];
  let i = 0;
  while (i < leaves.length) {
    const group = leaves[i].group;
    let j = i;
    while (j < leaves.length && leaves[j].group === group) j += 1;
    groups.push({ key: `group-${i}`, label: group, colSpan: j - i });
    i = j;
  }

  return { groups, leaves };
}

/** Same short weekday+date label as app/appointments/page.tsx's
 * formatDayLabel (copied — not exported there). Parsed as local, not
 * UTC, so the weekday shown matches the date shown. */
function formatDayLabel(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${month}/${day}`;
}

function formatAsOf(asOf: string | null): string {
  if (!asOf) return "";
  return new Date(asOf).toLocaleString();
}

export default function DosesGivenPage() {
  // Same shared-pharmacy-login session pattern as the appointment explorer.
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // Empty string until loadEarliestDayAndDefaultRange (below) resolves
  // the default range — every effect/handler below gates on
  // `appliedStart && appliedEnd` being non-empty, so the pivot fetch
  // never fires with a wrong (e.g. hardcoded 14-day) default first.
  const [earliestDay, setEarliestDay] = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [appliedStart, setAppliedStart] = useState("");
  const [appliedEnd, setAppliedEnd] = useState("");
  const [selectedQuickPick, setSelectedQuickPick] = useState<QuickPickId | null>(null);

  const [pivot, setPivot] = useState<DosesGivenPivot | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("byDay");

  function resetAfterSignOut() {
    setEarliestDay(null);
    setDraftStart("");
    setDraftEnd("");
    setAppliedStart("");
    setAppliedEnd("");
    setSelectedQuickPick(null);
    setPivot(null);
    setAsOf(null);
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

  // Fired once per sign-in, BEFORE the main pivot fetch — finds the
  // earliest ingested day (route's cheap `?earliestOnly=1` path) and
  // applies the resulting default range (lib/doses-given.ts's allRange:
  // earliest day through yesterday, or the old 14-day fallback when
  // nothing's been ingested). Degrades to that same fallback on any
  // fetch error rather than leaving the page stuck with no range at all.
  const loadEarliestDayAndDefaultRange = useCallback(async (token: string) => {
    let resolvedEarliest: string | null = null;
    try {
      const response = await fetch("/api/administered/doses-given?earliestOnly=1", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok && typeof data.earliestDay === "string") {
        resolvedEarliest = data.earliestDay;
      }
    } catch {
      // Degrade to allRange's own null-earliestDay fallback below.
    }
    setEarliestDay(resolvedEarliest);
    const range = allRange(resolvedEarliest);
    setDraftStart(range.start);
    setDraftEnd(range.end);
    setAppliedStart(range.start);
    setAppliedEnd(range.end);
    setSelectedQuickPick("all");
  }, []);

  useEffect(() => {
    if (session) void loadEarliestDayAndDefaultRange(session.accessToken);
  }, [session, loadEarliestDayAndDefaultRange]);

  const loadPivot = useCallback(async (token: string, start: string, end: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/administered/doses-given?start=${start}&end=${end}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setLoadError(data.error ?? "Could not load doses given data.");
        return;
      }
      const { start: _s, end: _e, asOf: responseAsOf, ...rest } = data;
      setPivot(rest as DosesGivenPivot);
      setAsOf(responseAsOf ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load doses given data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session && appliedStart && appliedEnd) void loadPivot(session.accessToken, appliedStart, appliedEnd);
  }, [session, appliedStart, appliedEnd, loadPivot]);

  function handleDraftStartChange(value: string) {
    setSelectedQuickPick(null);
    setDraftStart(value);
  }

  function handleDraftEndChange(value: string) {
    setSelectedQuickPick(null);
    setDraftEnd(value);
  }

  function handleApply() {
    setSelectedQuickPick(null);
    setAppliedStart(draftStart);
    setAppliedEnd(draftEnd);
  }

  function handleQuickPick(id: QuickPickId) {
    const range = quickPickRange(id, earliestDay);
    setSelectedQuickPick(id);
    setDraftStart(range.start);
    setDraftEnd(range.end);
    setAppliedStart(range.start);
    setAppliedEnd(range.end);
  }

  function handleRefresh() {
    if (session && appliedStart && appliedEnd) void loadPivot(session.accessToken, appliedStart, appliedEnd);
  }

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

  const productTotals = useMemo(() => (pivot ? productTotalsDescending(pivot) : []), [pivot]);
  const orderedProducts = useMemo(() => (pivot ? orderProductsByGroup(pivot.products) : []), [pivot]);
  const headerRows = useMemo(() => buildProductHeaderRows(orderedProducts), [orderedProducts]);
  // V-doses-given (Will 2026-09-13, verbatim: "We're closed on sat/sun,
  // so if there is no data on those days, then no need to show them.") —
  // hides a Saturday/Sunday row with 0 doses from the "By day" table.
  // CSV export (handleDownloadCsv below) still reads pivot.dates directly
  // and keeps every day, unchanged.
  const visibleDates = useMemo(
    () =>
      pivot
        ? visibleDayRows(pivot.dates.map((date) => ({ date, total: pivot.totalsByDate[date] }))).map((row) => row.date)
        : [],
    [pivot]
  );

  function handleDownloadCsv() {
    if (!pivot) return;
    const csv = viewMode === "byDay" ? dosesGivenPivotToCsv(pivot) : productTotalsToCsv(pivot);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `doses_given_${appliedStart}_${appliedEnd}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to explore doses given."
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

  const rangeLoading = !appliedStart || !appliedEnd;

  return (
    <main style={styles.main}>
      <style>{"@keyframes doses-given-spin { to { transform: rotate(360deg); } }"}</style>
      <h1 style={styles.heading}>Doses given</h1>
      <p style={styles.backLink}>
        <a href="/appointments">← Back to Schedule</a>
      </p>

      <div style={styles.controlsRow}>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="doses-given-start">
            Start
          </label>
          <input
            id="doses-given-start"
            type="date"
            style={styles.input}
            value={draftStart}
            onChange={(event) => handleDraftStartChange(event.target.value)}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="doses-given-end">
            End
          </label>
          <input
            id="doses-given-end"
            type="date"
            style={styles.input}
            value={draftEnd}
            onChange={(event) => handleDraftEndChange(event.target.value)}
          />
        </div>
        <button type="button" style={styles.button} onClick={handleApply} disabled={rangeLoading}>
          Apply
        </button>

        <div style={styles.controlGroup}>
          <span style={styles.label}>Quick range</span>
          <div style={styles.toggleRow}>
            {QUICK_PICKS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                style={selectedQuickPick === id ? styles.toggleButtonActive : styles.toggleButton}
                onClick={() => handleQuickPick(id)}
                disabled={rangeLoading}
                aria-pressed={selectedQuickPick === id}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.controlGroup}>
          <span style={styles.label}>View</span>
          <div style={styles.toggleRow}>
            <button
              type="button"
              style={viewMode === "byDay" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setViewMode("byDay")}
              aria-pressed={viewMode === "byDay"}
            >
              By day
            </button>
            <button
              type="button"
              style={viewMode === "byProduct" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setViewMode("byProduct")}
              aria-pressed={viewMode === "byProduct"}
            >
              By product
            </button>
          </div>
        </div>

        <button type="button" style={styles.button} onClick={handleRefresh} disabled={loading || rangeLoading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>

        <button type="button" style={styles.button} onClick={handleDownloadCsv} disabled={!pivot || pivot.grandTotal === 0}>
          Download CSV
        </button>

        {asOf && <span style={styles.muted}>Data as of {formatAsOf(asOf)}</span>}
      </div>

      {pivot && !rangeLoading && (
        <p style={styles.summary}>{formatRangeSummary(pivot.grandTotal, appliedStart, appliedEnd)}</p>
      )}

      {loadError && <p style={styles.error}>{loadError}</p>}

      <div style={styles.resultsAreaWrap}>
        {(loading || rangeLoading) && (
          <div style={styles.loadingOverlay} role="status" aria-live="polite">
            <span style={styles.spinner} aria-hidden="true" />
            <span style={styles.loadingLabel}>Loading…</span>
          </div>
        )}
        <div style={{ opacity: loading || rangeLoading ? 0.45 : 1, transition: "opacity 150ms ease" }}>
          {pivot && pivot.grandTotal === 0 && !loadError && (
            <p style={styles.muted}>No doses given found in this range.</p>
          )}

          {pivot && pivot.grandTotal > 0 && viewMode === "byDay" && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <colgroup>
                  {/* Date column: no explicit width, sizes to its own
                      content — same convention as the Schedule table. */}
                  <col />
                  <col style={{ width: `${TOTAL_COL_WIDTH_PX}px` }} />
                  {orderedProducts.map((product) => (
                    <col key={product} style={{ width: `${DATA_COL_WIDTH_PX}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th style={styles.thType} rowSpan={2}>
                      Date
                    </th>
                    <th style={styles.thLeaf} rowSpan={2}>
                      Total
                    </th>
                    {headerRows.groups.map((cell) => (
                      <th key={cell.key} style={groupHeaderStyle(cell.label)} colSpan={cell.colSpan}>
                        {cell.label}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {headerRows.leaves.map((cell) => (
                      <th key={cell.key} style={leafHeaderStyle(cell.group)}>
                        {cell.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={styles.totalRow}>
                    <td style={styles.totalRowLabel}>Total</td>
                    <td style={styles.totalCell}>{pivot.grandTotal}</td>
                    {orderedProducts.map((product) => (
                      <td key={product} style={styles.totalCell}>
                        {pivot.totalsByProduct[product]}
                      </td>
                    ))}
                  </tr>
                  {visibleDates.map((date) => (
                    <tr key={date}>
                      <td style={styles.tdType}>{formatDayLabel(date)}</td>
                      <td style={styles.totalCell}>{pivot.totalsByDate[date]}</td>
                      {orderedProducts.map((product) => {
                        const count = pivot.countsByDateProduct[date][product];
                        return (
                          <td key={product} style={dataCellStyle(count === 0)}>
                            {count}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pivot && pivot.grandTotal > 0 && viewMode === "byProduct" && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <colgroup>
                  <col />
                  <col style={{ width: `${TOTAL_COL_WIDTH_PX}px` }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={styles.thType}>Product</th>
                    <th style={styles.thLeaf}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {productTotals.map(({ product, total }) => (
                    <tr key={product}>
                      <td style={styles.tdType}>{vaccineDisplayName(product)}</td>
                      <td style={styles.totalCell}>{total}</td>
                    </tr>
                  ))}
                  <tr style={styles.totalRow}>
                    <td style={styles.totalRowLabel}>Total</td>
                    <td style={styles.totalCell}>{pivot.grandTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
