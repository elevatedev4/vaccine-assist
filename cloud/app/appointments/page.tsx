"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";

type AppointmentTypeCount = {
  date: string;
  appointmentTypeId: number;
  appointmentTypeName: string;
  count: number;
};

type PollResponse = {
  configured: boolean;
  message?: string;
  settingsUrl?: string;
  range: { start: string; end: string };
  counts: AppointmentTypeCount[];
  cacheHit: boolean;
  asOf: string | null;
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
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
  day: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.75rem 1rem",
    marginBottom: "0.75rem",
  },
  dayHeader: { display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: "0.5rem" },
  typeRow: { display: "flex", justifyContent: "space-between", padding: "0.125rem 0" },
} as const;

/** "YYYY-MM-DD" in the browser's LOCAL timezone (not UTC) — the pharmacy
 * cares about its own local day, and the server has no reliable notion of
 * that, so the client computes the range and passes it explicitly. */
function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextSevenDayRange(): { start: string; end: string; days: string[] } {
  const today = new Date();
  const days: string[] = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    days.push(localDateString(d));
  }
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

  const loadCounts = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const { start, end } = nextSevenDayRange();
      const response = await fetch(`/api/acuity/poll?start=${start}&end=${end}`, {
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
  const countsByDay = new Map<string, AppointmentTypeCount[]>();
  for (const entry of poll?.counts ?? []) {
    const existing = countsByDay.get(entry.date) ?? [];
    existing.push(entry);
    countsByDay.set(entry.date, existing);
  }

  return (
    <main style={styles.main}>
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
        <button style={styles.button} type="button" onClick={() => void loadCounts(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {poll?.asOf && (
          <span style={styles.muted}>
            Data as of {new Date(poll.asOf).toLocaleString()}
            {poll.cacheHit ? " (cached)" : ""}
          </span>
        )}
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}

      {poll && !poll.configured && (
        <p>
          {poll.message ?? "Acuity credentials are not configured yet."}{" "}
          <a href={poll.settingsUrl ?? "/settings"}>Go to Settings</a>
        </p>
      )}

      {poll && poll.configured && (
        <div>
          {days.map((day) => {
            const entries = countsByDay.get(day) ?? [];
            const total = entries.reduce((sum, e) => sum + e.count, 0);
            return (
              <div key={day} style={styles.day}>
                <div style={styles.dayHeader}>
                  <span>{formatDayLabel(day)}</span>
                  <span>{total} total</span>
                </div>
                {entries.length === 0 ? (
                  <p style={styles.muted}>No appointments.</p>
                ) : (
                  entries.map((entry) => (
                    <div key={`${entry.date}-${entry.appointmentTypeId}`} style={styles.typeRow}>
                      <span>{entry.appointmentTypeName}</span>
                      <span>{entry.count}</span>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
