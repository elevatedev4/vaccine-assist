"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { chicagoDayRange } from "@/lib/chicago-date";
import {
  buildAppointmentTable,
  computeHeatmapMaxes,
  computeTodayAndNext7Summaries,
  heatmapCellBackground,
  type AppointmentTableColumn,
  type ColumnTotals,
  type VaccineCount,
} from "@/lib/appointment-table";

// Re-poll cadence while the page is open and signed in (Will, 2026-08-16:
// "a reasonable refresh rate, maybe every 15 minutes"). Comfortably above
// ACUITY_POLL_CACHE_SECONDS (~5 min default) so most auto-refreshes still
// hit the server cache rather than Acuity.
const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

type AfterTodaySummary = ColumnTotals & { truncatedWindows: string[] };

type PollResponse = {
  configured: boolean;
  message?: string;
  settingsUrl?: string;
  range: { start: string; end: string };
  counts: VaccineCount[];
  possiblyTruncated: boolean;
  cacheHit: boolean;
  asOf: string | null;
};

// Reliability fix (2026-09-05): the "After today" summary comes from a
// SEPARATE `?afterTodayOnly=1` request (see app/api/acuity/poll/route.ts's
// doc comment) fired only after the main table's own request has already
// resolved — never bundled into the main PollResponse above. The 13-window
// fetch behind it is heavier and more failure-prone than the main range
// fetch; decoupling it means the main table renders (and stays usable) even
// if this one is slow or fails outright.
type AfterTodayResponse = {
  configured: boolean;
  afterToday: AfterTodaySummary | null;
  afterTodayError?: string;
};

// Total header-row depth: COVID needs 3 (group "COVID" -> brand "Pfizer"/
// "Moderna" -> age "3-11"/"12-64"/"65+" — ROUND 4 merges "Any" into "Pfizer",
// see lib/appointment-table.ts's resolveColumn); every other column
// (Flu/Common/Other) collapses into fewer rows via rowSpan (see
// buildHeaderRows below) but the <thead> itself always has this many
// <tr>s.
const HEADER_ROW_COUNT = 3;

// Column widths (ROUND 6, V-T12 answer, Will 2026-09-05, verbatim: "on my
// 24" monitor, it spreads out the table to make it fill space. Just make
// it take up the amount of space it should take up. Don't add extra
// inside the cells to fill the extra space.") — every vaccine (data)
// column gets the SAME small fixed pixel width regardless of viewport, so
// the table stays chart-like and compact instead of table-layout: fixed
// stretching equal-width columns out to fill a wide monitor. The date
// column is intentionally left with no explicit width (see the <colgroup>
// in AppointmentsPage) so it sizes to its own content ("Mon 9/5").
const DATA_COL_WIDTH_PX = 56;
// Total is a data-shaped column too (needs a fixed width, not "auto" like
// the date labels) but slightly wider than a vaccine column since a
// 7-day total can run to 3 digits.
const TOTAL_COL_WIDTH_PX = 60;

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  // No maxWidth here on purpose (V-T-schedule-table, Will 2026-09-04:
  // "everything visible at once, NOT scrollable") — the table page uses
  // the full viewport width instead of being squeezed into a 960px column
  // and forced to scroll horizontally to show the rest of the columns.
  // V-T11 (Will, verbatim): "Make the spacing even tighter. There is no
  // need to have so much dead space." Tightened page padding on top of the
  // ROUND 2 full-width layout.
  mainWide: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  warning: { color: "#8a5300", background: "#fff4e0", padding: "0.5rem 0.75rem", borderRadius: 4 },
  muted: { color: "#555", fontSize: "0.875rem" },
  // V-T11: page heading and action rows above the table get their default
  // browser margins collapsed down to a tight, deliberate amount instead —
  // that dead air was most of the gap between sign-in bar and the table.
  heading: { margin: "0.5rem 0 0.5rem" },
  actionsRow: { margin: "0 0 0.35rem" },
  autoRefreshNote: { color: "#555", fontSize: "0.875rem", margin: "0 0 0.5rem" },
  sessionBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.35rem 0.75rem",
    marginBottom: "0.5rem",
    background: "#f0f4f8",
    borderRadius: 4,
  },
  // Compact "read as a chart, not a document" table (V-T-schedule-table
  // ROUND 2, Will 2026-09-05: "make it look like a chart" — minimal
  // font/padding; V-T11: padding tightened further and header rows
  // shortened — "There is no need to have so much dead space"). ROUND 6
  // (V-T12): deliberately NO width: 100%/tableLayout: "fixed" here anymore
  // — those stretched every column to fill a wide monitor. The table now
  // sizes to its own content (natural width); each data <col>'s explicit
  // pixel width (see the <colgroup> below) is what keeps the columns
  // compact and equal-ish, not a percentage of the viewport.
  table: { borderCollapse: "collapse", fontSize: "0.72rem" },
  thType: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap",
  },
  // Group header (row 1 of 3): one cell spanning "COVID" or "Flu"'s whole
  // sub-column run — see thSub (row 2) and thLeaf (final row).
  thGroup: {
    textAlign: "center",
    padding: "0.1rem 0.25rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  // Brand sub-header (row 2, COVID only) — "Pfizer" / "Moderna" / "Any".
  // Kept even shorter than the other header rows (V-T11: "trim header row
  // heights") since it's the middle row of COVID's 3-level nested header.
  thSub: {
    textAlign: "center",
    padding: "0.05rem 0.25rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  // Leaf age header (row 2 for Flu, row 3 for COVID, or the single row
  // for a plain/non-grouped column via rowSpan).
  thLeaf: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  td: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee" },
  tdZero: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", color: "#bbb" },
  tdType: { textAlign: "left", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 500 },
  totalCell: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 600 },
  // Summary rows (Today / Next 7 days / After today — V-T9 answer, Will
  // 2026-09-05): bold, sit directly under the header. Only the LAST of
  // the three gets the heavier bottom border that separates the summary
  // block from the daily-breakdown rows below it — see summaryRowStyles
  // in AppointmentsPage.
  sumRowLabel: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "1px solid #ddd",
  },
  sumRowCell: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "1px solid #ddd",
  },
  sumRowLabelLast: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  sumRowCellLast: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  // Bare fallback only — does nothing when the (now compact, full-width)
  // table already fits, only kicks in a scrollbar if a viewport is truly
  // narrower than the table (e.g. a small laptop screen).
  tableWrap: { overflowX: "auto", marginTop: "0.4rem" },
} as const;

/**
 * Per-group header tints (V-T9 answer, Will 2026-09-05: "I need vertical
 * borders for the columns, and color differentiation between covid, flu,
 * and everything else"). Subtle, professional (this is a data tool, not a
 * poster) — light hues, dark default text stays fully readable on top of
 * them, one family per group: COVID blue, Flu amber, Common green, Other
 * violet.
 *
 * ROUND 6 (V-T12 answer, verbatim): "Remove the color of the data portions
 * of the table (leave the headings colored). Instead, color the background
 * a gradient based on the # of vaccines scheduled." So `data` tints are
 * GONE — every data cell's background now comes from
 * heatmapCellBackground (lib/appointment-table.ts) instead, and only the
 * group/sub-group/leaf HEADER cells still use this map (see
 * groupHeaderStyle/subHeaderStyle/leafHeaderStyle below).
 */
const GROUP_COLORS: Record<AppointmentTableColumn["group"], { header: string }> = {
  COVID: { header: "#dbe7f9" },
  Flu: { header: "#f9e2cc" },
  Common: { header: "#d7eede" },
  Other: { header: "#e3daf3" },
};

// V-T9: "I need vertical borders for the columns" — a 1px divider on the
// LEFT edge of every leaf/data cell, so every vaccine column (not just
// every group) reads as visually distinct. Group/sub-group header cells
// (which span multiple leaf columns) only need this same left border
// once, at the start of their own span — see groupHeaderStyle/
// subHeaderStyle below.
const COLUMN_DIVIDER = { borderLeft: "1px solid #c9c9c9" } as const;

function groupHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thGroup, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

function subHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thSub, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

function leafHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thLeaf, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

// ROUND 6: `background` comes from heatmapCellBackground
// (lib/appointment-table.ts), computed by the caller against whichever of
// the two independent scales the row belongs to (see dailyScaleMax /
// weeklyScaleMax in AppointmentsPage) — no more per-GROUP tint on data
// cells, only on headers (groupHeaderStyle/subHeaderStyle/leafHeaderStyle).
// Cell text is always the style's own default (black-ish for a nonzero
// cell, dimmed grey for a zero one, per styles.td/tdZero) — no text-color
// override (review fix, 2026-09-05: HEATMAP_MAX_INTENSITY in
// lib/appointment-table.ts is tuned so black text stays WCAG-AA-legible
// at every ratio, so no switch is needed; see that constant's doc
// comment).
function dataCellStyle(isZero: boolean, background: string) {
  return { ...(isZero ? styles.tdZero : styles.td), ...COLUMN_DIVIDER, background };
}

function summaryCellStyle(isLastSummaryRow: boolean, background: string) {
  return { ...(isLastSummaryRow ? styles.sumRowCellLast : styles.sumRowCell), ...COLUMN_DIVIDER, background };
}

// Third heatmap scale (Will's follow-up, verbatim: "Add heatmap to the
// daily totals for the upcoming forecast too") — paints the Total column
// for the Today summary row and every daily-breakdown row against
// `totalsScaleMax` (see computeHeatmapMaxes). Deliberately NO
// COLUMN_DIVIDER here (the Total column has never had a left border,
// unlike the per-vaccine columns) and no zero-dimmed variant (a day with
// 0 total is still a real "nothing scheduled" total; heatmapCellBackground
// already renders 0 as plain white on its own, same as everywhere else).
// `base` is whichever row's own Total-cell style (styles.totalCell for a
// daily-breakdown row, styles.sumRowCell for the Today summary row) so
// this only ever changes the background, nothing else about that row.
function totalCellStyle(base: typeof styles.totalCell | typeof styles.sumRowCell, background: string) {
  return { ...base, background };
}

// One <th> to render, with its col/row span — see buildHeaderRows.
// `group` drives GROUP_COLORS above; every header cell belongs to
// exactly one of the 4 groups (ROUND 4 — AppointmentTableColumn.group is
// no longer nullable).
type HeaderCell = {
  key: string;
  label: string;
  colSpan: number;
  rowSpan: number;
  group: AppointmentTableColumn["group"];
};

/**
 * Turns AppointmentTable.columns into the 3 header <tr>s the compact
 * chart-style table needs (V-T-schedule-table ROUND 2, Will 2026-09-05:
 * "make a heading above it, then subsection. Ex: Flu > 3-64, 65+, Unk,
 * COVID > Mod > 3-11, 12-64, 65+"; ROUND 4 regroups the plain columns
 * into "Common"/"Other" but the header SHAPE is unchanged — every column
 * now belongs to one of 4 groups instead of 2 groups + ungrouped):
 *   - row1: one spanning cell per contiguous group run (COVID, Flu,
 *     Common, or Other), colSpan = the run's width, rowSpan 1.
  *   - row2: COVID's brand cells ("Pfizer"/"Moderna", each spanning its own
 *     age sub-run); every OTHER group's (Flu/Common/Other) leaf cells,
 *     each with rowSpan=HEADER_ROW_COUNT-1=2 since only COVID has a
 *     brand level, so a non-COVID leaf cell must fill both remaining
 *     rows.
 *   - row3: COVID's leaf age cells only (every other group's columns
 *     already finished spanning by row2/row1).
 * Runs are contiguous stretches of `columns` sharing the same `group`
 * (and, within a COVID run, the same `subgroup`) — see
 * AppointmentTableColumn's doc comment in lib/appointment-table.ts.
 */
function buildHeaderRows(columns: AppointmentTableColumn[]): {
  row1: HeaderCell[];
  row2: HeaderCell[];
  row3: HeaderCell[];
} {
  const row1: HeaderCell[] = [];
  const row2: HeaderCell[] = [];
  const row3: HeaderCell[] = [];

  let i = 0;
  while (i < columns.length) {
    const column = columns[i];

    let j = i;
    while (j < columns.length && columns[j].group === column.group) j += 1;
    const run = columns.slice(i, j);
    row1.push({ key: `group-${i}`, label: column.group, colSpan: run.length, rowSpan: 1, group: column.group });

    if (column.group === "COVID") {
      // Subdivide the run into contiguous sub-runs by brand (subgroup),
      // one thSub cell per brand, then one leaf age cell per column
      // underneath.
      let k = 0;
      while (k < run.length) {
        const brand = run[k].subgroup;
        let m = k;
        while (m < run.length && run[m].subgroup === brand) m += 1;
        const subRun = run.slice(k, m);
        row2.push({
          key: `subgroup-${i}-${k}`,
          label: brand ?? "",
          colSpan: subRun.length,
          rowSpan: 1,
          group: column.group,
        });
        for (const leaf of subRun) {
          row3.push({ key: leaf.vaccineName, label: leaf.label, colSpan: 1, rowSpan: 1, group: leaf.group });
        }
        k = m;
      }
    } else {
      // Flu / Common / Other: no sub-group level — one leaf cell per
      // column, spanning both remaining header rows.
      for (const leaf of run) {
        row2.push({
          key: leaf.vaccineName,
          label: leaf.label,
          colSpan: 1,
          rowSpan: HEADER_ROW_COUNT - 1,
          group: leaf.group,
        });
      }
    }

    i = j;
  }

  return { row1, row2, row3 };
}

// Dim, deterministic zero-cell rendering (V-T-schedule-table ROUND 2,
// Will: "Zero cells may render as a dim '0' ... your call") — keeps the
// literal digit (unambiguous vs. a placeholder glyph like "·") but greys
// it out so a skim lands on the nonzero cells first; that dim styling
// stays even under ROUND 6's heatmap (a zero cell's heatmap background is
// always plain white anyway — see heatmapCellBackground). `dailyScaleMax`
// is the day-by-day breakdown's own independent scale (V-T12) — every
// breakdown row uses this same max, never the Next-7/After-today one.
function renderCount(column: AppointmentTableColumn, n: number, dailyScaleMax: number) {
  return (
    <td key={column.vaccineName} style={dataCellStyle(n === 0, heatmapCellBackground(n, dailyScaleMax))}>
      {n}
    </td>
  );
}

/**
 * Every "day" this page shows is a fixed America/Chicago calendar day
 * (lib/chicago-date.ts) — not the browser's own local day — so the range
 * requested from the poll API, and the columns rendered here, stay
 * correct regardless of what timezone a staff device happens to report.
 */
function nextSevenDayRange(): { start: string; end: string; days: string[] } {
  const days = chicagoDayRange(7);
  return { start: days[0], end: days[days.length - 1], days };
}

function formatDayLabel(dateStr: string): string {
  // Parse as local, not UTC, so the weekday shown matches the date shown.
  // Abbreviated ("Mon 8/17" not "Mon, Aug 17") — part of the compact-table
  // pass (V-T-schedule-table, Will 2026-09-04).
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${month}/${day}`;
}

export default function AppointmentsPage() {
  // Same shared-pharmacy-login session pattern as app/settings/page.tsx.
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [poll, setPoll] = useState<PollResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // "After today" state is entirely separate from `poll` (reliability fix,
  // 2026-09-05) — its own request, its own loading flag, its own error,
  // so a slow or failed after-today fetch never blocks or clears the main
  // table. `afterToday` stays `null` until the first successful fetch
  // lands; the render below shows a loading placeholder ("…") rather than
  // a misleading zero while that's true.
  const [afterToday, setAfterToday] = useState<AfterTodaySummary | null>(null);
  const [afterTodayLoading, setAfterTodayLoading] = useState(false);
  const [afterTodayError, setAfterTodayError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  const loadCounts = useCallback(async (token: string, options?: { force?: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const { start, end } = nextSevenDayRange();
      const forceParam = options?.force ? "&force=1" : "";
      const response = await fetch(`/api/acuity/poll?start=${start}&end=${end}${forceParam}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setLoadError(data.error ?? "Could not load appointment counts.");
        return;
      }
      setPoll(data as PollResponse);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load appointment counts.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Reliability fix (2026-09-05): a SEPARATE, later request — never part
  // of loadCounts above — so the (heavier, more failure-prone) 13-window
  // after-today fetch can never make the main table wait on it. See
  // app/api/acuity/poll/route.ts's `?afterTodayOnly=1` doc comment.
  const loadAfterToday = useCallback(async (token: string, options?: { force?: boolean }) => {
    setAfterTodayLoading(true);
    setAfterTodayError(undefined);
    try {
      const forceParam = options?.force ? "&force=1" : "";
      const response = await fetch(`/api/acuity/poll?afterTodayOnly=1${forceParam}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as AfterTodayResponse | { error: string };
      if (!response.ok) {
        setAfterTodayError("error" in data ? data.error : "Could not load the after-today summary.");
        return;
      }
      if ("error" in data) return; // unreachable in practice, satisfies the union
      setAfterToday(data.afterToday);
      setAfterTodayError(data.afterTodayError);
    } catch (err) {
      setAfterTodayError(err instanceof Error ? err.message : "Could not load the after-today summary.");
    } finally {
      setAfterTodayLoading(false);
    }
  }, []);

  // Kicks off the main table fetch and, once it settles, the separate
  // after-today fetch — "renders the main table first, then issues a
  // second fetch" (reliability fix): loadCounts's own setPoll call already
  // triggers a render before loadAfterToday's request even starts.
  const loadAll = useCallback(
    async (token: string, options?: { force?: boolean }) => {
      await loadCounts(token, options);
      void loadAfterToday(token, options);
    },
    [loadCounts, loadAfterToday]
  );

  useEffect(() => {
    if (session) void loadAll(session.accessToken);
  }, [session, loadAll]);

  // Auto-refresh every AUTO_REFRESH_INTERVAL_MS while signed in — cleared
  // on sign-out (session becomes null, effect re-runs and tears down the
  // old interval) and on unmount (the same cleanup path).
  useEffect(() => {
    if (!session) return;
    const token = session.accessToken;
    const intervalId = setInterval(() => {
      void loadAll(token);
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
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

  async function handleSignOut() {
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Fall through — clear local state regardless.
    } finally {
      setSession(null);
      setPoll(null);
      setLoadError(null);
      setAfterToday(null);
      setAfterTodayError(undefined);
    }
  }

  if (!authChecked) {
    return (
      <main style={styles.main}>
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main style={styles.main}>
        <p>
          <strong>Not signed in</strong>
        </p>
        <h1>Sign in</h1>
        <p>Use the shared pharmacy login to view appointment counts.</p>
        <form onSubmit={handleSignIn}>
          <label style={styles.label} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            style={styles.field}
            value={signInEmail}
            onChange={(e) => setSignInEmail(e.target.value)}
            required
          />
          <label style={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            style={styles.field}
            value={signInPassword}
            onChange={(e) => setSignInPassword(e.target.value)}
            required
          />
          {signInError && <p style={styles.error}>{signInError}</p>}
          <button style={styles.button} type="submit" disabled={signingIn}>
            {signingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  const { days } = nextSevenDayRange();
  const table = buildAppointmentTable(poll?.counts ?? [], days);
  const headerRows = buildHeaderRows(table.columns);
  // Three summary rows (V-T9 answer) — "Today" and "Next 7 days" are pure
  // slices of this same 8-day table, cleanly partitioning it (see
  // computeTodayAndNext7Summaries's doc comment for the partition
  // semantics); "After today" comes from the separate `afterToday` state
  // (loadAfterToday above), populated by its own later, independent
  // request — see that state's doc comment for why it's never part of
  // `poll`.
  const { today: todaySummary, next7: next7Summary } = computeTodayAndNext7Summaries(table);
  // ROUND 6 heatmap (V-T12 answer): INDEPENDENT SCALES, never one combined
  // scale — "Today and the daily breakdown would be its own scale,
  // separate from the weekly and remaining ... wouldn't make sense to
  // have weekly numbers compared to daily numbers." `dailyScaleMax`
  // normalizes the "Today" summary row AND every day-by-day breakdown
  // row's PER-VACCINE cells; `weeklyScaleMax` normalizes "Next 7 days" and
  // "After today"'s per-vaccine cells only. `totalsScaleMax` (Will's
  // follow-up: "Add heatmap to the daily totals for the upcoming forecast
  // too") is a THIRD, separate scale over the 8-day daily breakdown's
  // Total-column values only — see computeHeatmapMaxes's doc comment for
  // why a day's total needs its own scale instead of sharing
  // `dailyScaleMax`. `afterToday?.byColumnId` is passed as `null` while it
  // hasn't loaded yet (or failed) so the scale doesn't silently miss real
  // data once it lands — see the afterToday state's own doc comment above.
  const { dailyScaleMax, weeklyScaleMax, totalsScaleMax } = computeHeatmapMaxes(
    table,
    todaySummary.byColumnId,
    next7Summary.byColumnId,
    afterToday?.byColumnId ?? null
  );

  return (
    <main style={styles.mainWide}>
      <div style={styles.sessionBar}>
        <span>
          Signed in as <strong>{session.email ?? "unknown user"}</strong>
        </span>
        <button style={styles.button} type="button" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </div>

      <h1 style={styles.heading}>Upcoming appointments</h1>

      <p style={styles.actionsRow}>
        <button
          style={styles.button}
          type="button"
          onClick={() => void loadAll(session.accessToken, { force: true })}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {poll?.asOf && (
          <span style={styles.muted}>
            Data as of {new Date(poll.asOf).toLocaleString()}
            {poll.cacheHit ? " (cached)" : ""}
          </span>
        )}
      </p>
      <p style={styles.autoRefreshNote}>Auto-refreshes every 15 minutes while this page is open.</p>

      {loadError && <p style={styles.error}>{loadError}</p>}

      {poll && !poll.configured && (
        <p>
          {poll.message ?? "Acuity credentials are not configured yet."}{" "}
          <a href={poll.settingsUrl ?? "/settings"}>Go to Settings</a>
        </p>
      )}

      {poll?.configured && poll.possiblyTruncated && (
        <p style={styles.warning}>
          100+ appointments in range — counts may be incomplete.
        </p>
      )}

      {afterToday && afterToday.truncatedWindows.length > 0 && (
        <p style={styles.warning}>
          100+ appointments in one or more future weeks ({afterToday.truncatedWindows.join(", ")}) — &quot;After
          today&quot; may be incomplete for those weeks.
        </p>
      )}

      {afterTodayError && (
        <p style={styles.warning}>Could not compute &quot;After today&quot;: {afterTodayError}</p>
      )}

      {poll && poll.configured && (
        // Vaccine types run across the top (columns); dates run down the
        // left (rows) — Will, V-T7: "type go across the top ... dates go
        // down". Every vaccine column is FIXED (V-T-schedule-table
        // ROUND 2) — it renders even at zero, even when `poll.counts` is
        // empty — with "Total" moved to the 2nd column, right after
        // "Scheduled date", per Will's mockup order. Every column belongs
        // to one of 4 groups (ROUND 4, V-T9): COVID (brand -> age),
        // Flu (age), Common (Shingles/Pneumonia/Tdap/RSV/HPV), or Other
        // (everything else) — buildHeaderRows renders COVID as a 3-level
        // nested header and the other 3 groups as 2-level, each group's
        // HEADER cells tinted its own color with a vertical divider
        // between every column (leafHeaderStyle/etc. — ROUND 6 removed
        // that tint from DATA cells, see dataCellStyle). Three summary
        // rows (Today / Next 7 days / After today) sit above the
        // day-by-day breakdown (today + the following 7 days, 8 rows) —
        // see computeTodayAndNext7Summaries in lib/appointment-table.ts
        // for "Today"/"Next 7 days", and the separate `afterToday` state
        // (loadAfterToday above, lib/acuity-future-summary.ts) for "After
        // today" — it shows a "…"/"—" placeholder instead of 0 until its
        // own independent fetch actually lands, so a slow or failed
        // after-today fetch never LOOKS like "zero appointments," and
        // never gets a heatmap tint while in that state either.
        //
        // ROUND 6 heatmap (V-T12, green ramp per V-T14): every DATA cell's
        // background is now a white -> green gradient by count instead of
        // a per-group tint (heatmapCellBackground, lib/appointment-table.ts),
        // on INDEPENDENT SCALES — dailyScaleMax for Today + the daily
        // breakdown's PER-VACCINE cells, weeklyScaleMax for Next 7 days +
        // After today's per-vaccine cells (see computeHeatmapMaxes above).
        // The "Scheduled date" column is never part of any scale (it isn't
        // a count at all).
        //
        // Follow-up (Will, verbatim: "Add heatmap to the daily totals for
        // the upcoming forecast too"): the Total column ALSO gets the same
        // green ramp now, but on its OWN third scale (totalsScaleMax) — see
        // computeHeatmapMaxes's doc comment for why a day's total can't
        // share dailyScaleMax with the per-vaccine cells (it's roughly an
        // order of magnitude bigger and would crush one gradient or the
        // other). This paints the Total cell for the "Today" summary row
        // AND every daily-breakdown row (today + the following 7 days) —
        // JUDGMENT CALL (doc-commented per the brief): "Today"'s Total is
        // literally the same number as the first daily-breakdown row's
        // Total (both are table.dailyTotals[table.days[0]]), so heatmapping
        // one but not the other would show the identical value two
        // different ways a few pixels apart, which reads as a bug rather
        // than a design choice. "Next 7 days" and "After today"'s totals
        // stay deliberately PLAIN (no heatmap) — those are yet another,
        // larger magnitude class (up to ~13 weeks of appointments summed),
        // so folding them into totalsScaleMax would crush the daily-totals
        // gradient the same way mixing per-vaccine and total counts would.
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <colgroup>
              {/* Date column: no explicit width — ROUND 6 (V-T12) sizes it
                  to its own content ("Mon 9/5") rather than stretching it
                  to a fixed viewport percentage. */}
              <col />
              <col style={{ width: `${TOTAL_COL_WIDTH_PX}px` }} />
              {table.columns.map((column) => (
                <col key={column.vaccineName} style={{ width: `${DATA_COL_WIDTH_PX}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th style={styles.thType} rowSpan={HEADER_ROW_COUNT}>
                  Scheduled date
                </th>
                <th style={styles.thLeaf} rowSpan={HEADER_ROW_COUNT}>
                  Total
                </th>
                {headerRows.row1.map((cell) => (
                  <th key={cell.key} style={groupHeaderStyle(cell.group)} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                    {cell.label}
                  </th>
                ))}
              </tr>
              <tr>
                {headerRows.row2.map((cell) =>
                  cell.rowSpan === HEADER_ROW_COUNT - 1 ? (
                    <th key={cell.key} style={leafHeaderStyle(cell.group)} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  ) : (
                    <th key={cell.key} style={subHeaderStyle(cell.group)} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  )
                )}
              </tr>
              <tr>
                {headerRows.row3.map((cell) => (
                  <th key={cell.key} style={leafHeaderStyle(cell.group)} rowSpan={cell.rowSpan}>
                    {cell.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.sumRowLabel}>Today</td>
                <td style={totalCellStyle(styles.sumRowCell, heatmapCellBackground(todaySummary.total, totalsScaleMax))}>
                  {todaySummary.total}
                </td>
                {table.columns.map((column) => {
                  const count = todaySummary.byColumnId[column.vaccineName] ?? 0;
                  return (
                    <td key={column.vaccineName} style={summaryCellStyle(false, heatmapCellBackground(count, dailyScaleMax))}>
                      {count}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td style={styles.sumRowLabel}>Next 7 days</td>
                <td style={styles.sumRowCell}>{next7Summary.total}</td>
                {table.columns.map((column) => {
                  const count = next7Summary.byColumnId[column.vaccineName] ?? 0;
                  return (
                    <td key={column.vaccineName} style={summaryCellStyle(false, heatmapCellBackground(count, weeklyScaleMax))}>
                      {count}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td style={styles.sumRowLabelLast}>After today</td>
                <td style={styles.sumRowCellLast}>
                  {afterToday ? afterToday.total : afterTodayLoading ? "…" : "—"}
                </td>
                {table.columns.map((column) => {
                  // Loading/error state ("…"/"—") is unaffected by the
                  // heatmap — no count yet, so no tint (plain white)
                  // rather than guessing a background off a placeholder.
                  const count = afterToday ? (afterToday.byColumnId[column.vaccineName] ?? 0) : null;
                  const background = count !== null ? heatmapCellBackground(count, weeklyScaleMax) : "#ffffff";
                  return (
                    <td key={column.vaccineName} style={summaryCellStyle(true, background)}>
                      {count !== null ? count : afterTodayLoading ? "…" : "—"}
                    </td>
                  );
                })}
              </tr>
              {table.days.map((day) => (
                <tr key={day}>
                  <td style={styles.tdType}>{formatDayLabel(day)}</td>
                  <td style={totalCellStyle(styles.totalCell, heatmapCellBackground(table.dailyTotals[day], totalsScaleMax))}>
                    {table.dailyTotals[day]}
                  </td>
                  {table.columns.map((column, index) => renderCount(column, table.rows[index].countsByDay[day], dailyScaleMax))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
