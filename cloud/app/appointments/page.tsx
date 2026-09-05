"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { chicagoDayRange } from "@/lib/chicago-date";
import { buildAppointmentTable, type AppointmentTableColumn, type VaccineCount } from "@/lib/appointment-table";

// Re-poll cadence while the page is open and signed in (Will, 2026-08-16:
// "a reasonable refresh rate, maybe every 15 minutes"). Comfortably above
// ACUITY_POLL_CACHE_SECONDS (~5 min default) so most auto-refreshes still
// hit the server cache rather than Acuity.
const AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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

// Total header-row depth: COVID needs 3 (group "COVID" -> brand "Pfizer"/
// "Mod"/"Any" -> age "3-11"/"12-64"/"65+"); every other column collapses
// into fewer rows via rowSpan (see buildHeaderRows below) but the <thead>
// itself always has this many <tr>s.
const HEADER_ROW_COUNT = 3;

// Column widths (percent of table width) for the two non-vaccine columns
// — every vaccine column below splits the remainder evenly. See
// dataColumnWidthPct in AppointmentsPage.
const DATE_COL_WIDTH_PCT = 9;
const TOTAL_COL_WIDTH_PCT = 5;

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  // No maxWidth here on purpose (V-T-schedule-table, Will 2026-09-04:
  // "everything visible at once, NOT scrollable") — the table page uses
  // the full viewport width instead of being squeezed into a 960px column
  // and forced to scroll horizontally to show the rest of the columns.
  mainWide: { fontFamily: "system-ui, sans-serif", padding: "1.5rem 2rem" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  warning: { color: "#8a5300", background: "#fff4e0", padding: "0.5rem 0.75rem", borderRadius: 4 },
  muted: { color: "#555", fontSize: "0.875rem" },
  sessionBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.5rem 0.75rem",
    marginBottom: "1rem",
    background: "#f0f4f8",
    borderRadius: 4,
  },
  // Compact "read as a chart, not a document" table (V-T-schedule-table
  // ROUND 2, Will 2026-09-05: "make it look like a chart" — equal-width
  // columns via table-layout: fixed + a <colgroup>, minimal font/padding).
  table: { width: "100%", tableLayout: "fixed", borderCollapse: "collapse", fontSize: "0.72rem" },
  thType: {
    textAlign: "left",
    padding: "0.15rem 0.3rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap",
  },
  // Group header (row 1 of 3): one cell spanning "COVID" or "Flu"'s whole
  // sub-column run — see thSub (row 2) and thLeaf (final row).
  thGroup: {
    textAlign: "center",
    padding: "0.15rem 0.3rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  // Brand sub-header (row 2, COVID only) — "Pfizer" / "Mod" / "Any".
  thSub: {
    textAlign: "center",
    padding: "0.1rem 0.3rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  // Leaf age header (row 2 for Flu, row 3 for COVID, or the single row
  // for a plain/non-grouped column via rowSpan).
  thLeaf: {
    textAlign: "right",
    padding: "0.15rem 0.3rem",
    borderBottom: "2px solid #ccc",
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  td: { textAlign: "right", padding: "0.15rem 0.3rem", borderBottom: "1px solid #eee" },
  tdZero: { textAlign: "right", padding: "0.15rem 0.3rem", borderBottom: "1px solid #eee", color: "#bbb" },
  tdType: { textAlign: "left", padding: "0.15rem 0.3rem", borderBottom: "1px solid #eee", fontWeight: 500 },
  totalCell: { textAlign: "right", padding: "0.15rem 0.3rem", borderBottom: "1px solid #eee", fontWeight: 600 },
  // 7-day-sum row: bold, sits directly under the header, separated from
  // the daily-breakdown rows below it by a heavier bottom border.
  sumRowLabel: {
    textAlign: "left",
    padding: "0.15rem 0.3rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  sumRowCell: {
    textAlign: "right",
    padding: "0.15rem 0.3rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  // Bare fallback only — does nothing when the (now compact, full-width)
  // table already fits, only kicks in a scrollbar if a viewport is truly
  // narrower than the table (e.g. a small laptop screen).
  tableWrap: { overflowX: "auto", marginTop: "0.75rem" },
} as const;

// One <th> to render, with its col/row span — see buildHeaderRows.
type HeaderCell = { key: string; label: string; colSpan: number; rowSpan: number };

/**
 * Turns AppointmentTable.columns into the 3 header <tr>s the compact
 * chart-style table needs (V-T-schedule-table ROUND 2, Will 2026-09-05:
 * "make a heading above it, then subsection. Ex: Flu > 3-64, 65+, Unk,
 * COVID > Mod > 3-11, 12-64, 65+"):
 *   - row1: one spanning "COVID" cell over its whole brand x age run, one
 *     spanning "Flu" cell over its age run, and every plain column as its
 *     own cell with rowSpan=HEADER_ROW_COUNT (so it visually occupies all
 *     3 header rows without repeating).
 *   - row2: COVID's brand cells ("Pfizer"/"Mod"/"Any", each spanning its
 *     own age sub-run), and Flu's leaf age cells (each with
 *     rowSpan=HEADER_ROW_COUNT-1=2, since Flu has no brand level and its
 *     age cell must fill both remaining rows).
 *   - row3: COVID's leaf age cells only (Flu and plain columns already
 *     finished spanning by row2/row1).
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

    if (column.group === null) {
      row1.push({ key: column.vaccineName, label: column.label, colSpan: 1, rowSpan: HEADER_ROW_COUNT });
      i += 1;
      continue;
    }

    let j = i;
    while (j < columns.length && columns[j].group === column.group) j += 1;
    const run = columns.slice(i, j);
    row1.push({ key: `group-${i}`, label: column.group, colSpan: run.length, rowSpan: 1 });

    if (column.group === "Flu") {
      for (const leaf of run) {
        row2.push({ key: leaf.vaccineName, label: leaf.label, colSpan: 1, rowSpan: HEADER_ROW_COUNT - 1 });
      }
    } else {
      // COVID: subdivide the run into contiguous sub-runs by brand
      // (subgroup), one thSub cell per brand, then one leaf age cell per
      // column underneath.
      let k = 0;
      while (k < run.length) {
        const brand = run[k].subgroup;
        let m = k;
        while (m < run.length && run[m].subgroup === brand) m += 1;
        const subRun = run.slice(k, m);
        row2.push({ key: `subgroup-${i}-${k}`, label: brand ?? "", colSpan: subRun.length, rowSpan: 1 });
        for (const leaf of subRun) {
          row3.push({ key: leaf.vaccineName, label: leaf.label, colSpan: 1, rowSpan: 1 });
        }
        k = m;
      }
    }

    i = j;
  }

  return { row1, row2, row3 };
}

// Dim, deterministic zero-cell rendering (V-T-schedule-table ROUND 2,
// Will: "Zero cells may render as a dim '0' ... your call") — keeps the
// literal digit (unambiguous vs. a placeholder glyph like "·") but greys
// it out so a skim lands on the nonzero cells first.
function renderCount(key: string, n: number) {
  return (
    <td key={key} style={n === 0 ? styles.tdZero : styles.td}>
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

  useEffect(() => {
    if (session) void loadCounts(session.accessToken);
  }, [session, loadCounts]);

  // Auto-refresh every AUTO_REFRESH_INTERVAL_MS while signed in — cleared
  // on sign-out (session becomes null, effect re-runs and tears down the
  // old interval) and on unmount (the same cleanup path).
  useEffect(() => {
    if (!session) return;
    const token = session.accessToken;
    const intervalId = setInterval(() => {
      void loadCounts(token);
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [session, loadCounts]);

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
  // Equal-width data columns (V-T-schedule-table ROUND 2: "make it look
  // like a chart") via table-layout: fixed + an explicit <colgroup> — the
  // Date and Total columns get their own (narrower/wider) share, every
  // vaccine column splits the rest evenly regardless of label length.
  const dataColumnWidthPct =
    table.columns.length > 0 ? (100 - DATE_COL_WIDTH_PCT - TOTAL_COL_WIDTH_PCT) / table.columns.length : 0;

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

      <h1>Upcoming appointments</h1>

      <p>
        <button
          style={styles.button}
          type="button"
          onClick={() => void loadCounts(session.accessToken, { force: true })}
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
      <p style={styles.muted}>Auto-refreshes every 15 minutes while this page is open.</p>

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

      {poll && poll.configured && (
        // Vaccine types run across the top (columns); dates run down the
        // left (rows) — Will, V-T7: "type go across the top ... dates go
        // down". First data row under the header is the 7-day sum per
        // type, before the day-by-day breakdown starts. Every vaccine
        // column is FIXED (V-T-schedule-table ROUND 2) — it renders even
        // at zero, even when `poll.counts` is empty — with "Total" moved
        // to the 2nd column, right after "Scheduled date", per Will's
        // mockup order. COVID and Flu render as nested group headers
        // (buildHeaderRows): COVID group -> brand ("Pfizer"/"Mod"/"Any")
        // -> age; Flu group -> age. Every other column is a single cell
        // spanning all 3 header rows.
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <colgroup>
              <col style={{ width: `${DATE_COL_WIDTH_PCT}%` }} />
              <col style={{ width: `${TOTAL_COL_WIDTH_PCT}%` }} />
              {table.columns.map((column) => (
                <col key={column.vaccineName} style={{ width: `${dataColumnWidthPct}%` }} />
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
                {headerRows.row1.map((cell) =>
                  cell.rowSpan === HEADER_ROW_COUNT ? (
                    <th key={cell.key} style={styles.thLeaf} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  ) : (
                    <th key={cell.key} style={styles.thGroup} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  )
                )}
              </tr>
              <tr>
                {headerRows.row2.map((cell) =>
                  cell.rowSpan === HEADER_ROW_COUNT - 1 ? (
                    <th key={cell.key} style={styles.thLeaf} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  ) : (
                    <th key={cell.key} style={styles.thSub} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                      {cell.label}
                    </th>
                  )
                )}
              </tr>
              <tr>
                {headerRows.row3.map((cell) => (
                  <th key={cell.key} style={styles.thLeaf} rowSpan={cell.rowSpan}>
                    {cell.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.sumRowLabel}>7-day total</td>
                <td style={styles.sumRowCell}>{table.grandTotal}</td>
                {table.rows.map((row) => (
                  <td key={row.vaccineName} style={styles.sumRowCell}>
                    {row.total}
                  </td>
                ))}
              </tr>
              {table.days.map((day) => (
                <tr key={day}>
                  <td style={styles.tdType}>{formatDayLabel(day)}</td>
                  <td style={styles.totalCell}>{table.dailyTotals[day]}</td>
                  {table.rows.map((row) => renderCount(row.vaccineName, row.countsByDay[day]))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
