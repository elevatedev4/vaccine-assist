"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { chicagoDayRange } from "@/lib/chicago-date";
import { buildAppointmentTable, type VaccineCount } from "@/lib/appointment-table";

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

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  mainWide: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 960 },
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
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" },
  th: { textAlign: "right", padding: "0.4rem 0.6rem", borderBottom: "2px solid #ccc", whiteSpace: "nowrap" },
  thType: { textAlign: "left", padding: "0.4rem 0.6rem", borderBottom: "2px solid #ccc", whiteSpace: "nowrap" },
  td: { textAlign: "right", padding: "0.4rem 0.6rem", borderBottom: "1px solid #eee" },
  tdType: { textAlign: "left", padding: "0.4rem 0.6rem", borderBottom: "1px solid #eee", fontWeight: 500 },
  totalCell: { textAlign: "right", padding: "0.4rem 0.6rem", borderBottom: "1px solid #eee", fontWeight: 600 },
  // 7-day-sum row: bold, sits directly under the header, separated from
  // the daily-breakdown rows below it by a heavier bottom border.
  sumRowLabel: {
    textAlign: "left",
    padding: "0.4rem 0.6rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  sumRowCell: {
    textAlign: "right",
    padding: "0.4rem 0.6rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  tableWrap: { overflowX: "auto", marginTop: "0.75rem" },
} as const;

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
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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
        // type, before the day-by-day breakdown starts.
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.thType}>Date</th>
                {table.rows.map((row) => (
                  <th key={row.vaccineName} style={styles.th}>
                    {row.vaccineName}
                  </th>
                ))}
                <th style={styles.th}>Total</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.length === 0 ? (
                <tr>
                  <td style={styles.tdType} colSpan={2}>
                    No appointments in this range.
                  </td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td style={styles.sumRowLabel}>7-day total</td>
                    {table.rows.map((row) => (
                      <td key={row.vaccineName} style={styles.sumRowCell}>
                        {row.total}
                      </td>
                    ))}
                    <td style={styles.sumRowCell}>{table.grandTotal}</td>
                  </tr>
                  {table.days.map((day) => (
                    <tr key={day}>
                      <td style={styles.tdType}>{formatDayLabel(day)}</td>
                      {table.rows.map((row) => (
                        <td key={row.vaccineName} style={styles.td}>
                          {row.countsByDay[day]}
                        </td>
                      ))}
                      <td style={styles.totalCell}>{table.dailyTotals[day]}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
