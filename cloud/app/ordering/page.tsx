"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";

/**
 * Web edition of the desktop app's Ordering tab
 * (desktop/VaccineAssist.Desktop/Views/OrderingView.xaml +
 * ViewModels/OrderingViewModel.cs) — reorder recommendations from GET
 * /api/ordering/recommendation (no new API route; see that route's
 * RESPONSE CONTRACT doc comment). Same sort order
 * (recommendedOrder desc, then vaccineName asc) and on-hand display
 * ("{qty} (as of {date})" / "no data yet") as OrderingViewModel.
 */

type RecommendationRow = {
  vaccineId: string;
  vaccineName: string;
  upcoming7d: number;
  onHand: number | null;
  onHandAsOf: string | null;
  recommendedOrder: number;
};

type RecommendationResponse = {
  onHandLastReceivedAt: string | null;
  rows: RecommendationRow[];
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
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
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  thRight: { textAlign: "right", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
} as const;

function onHandDisplay(row: RecommendationRow): string {
  if (row.onHand === null) return "no data yet";
  if (row.onHandAsOf) {
    const asOf = new Date(row.onHandAsOf);
    return `${row.onHand} (as of ${asOf.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
  }
  return String(row.onHand);
}

function onHandStatusMessage(lastReceivedAt: string | null): string {
  if (lastReceivedAt) {
    return `On-hand data last received: ${new Date(lastReceivedAt).toLocaleString()}`;
  }
  return (
    "No on-hand data received yet — email format: one line per vaccine, " +
    '"VaccineName, Quantity" (see cloud/lib/on-hand-parser.ts for the full spec).'
  );
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

  async function handleSignOut() {
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Fall through — clear local state regardless.
    } finally {
      setSession(null);
      setData(null);
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
        <p>Use the shared pharmacy login to view ordering recommendations.</p>
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

  const rows = data
    ? [...data.rows].sort((a, b) => {
        if (a.recommendedOrder !== b.recommendedOrder) return b.recommendedOrder - a.recommendedOrder;
        return a.vaccineName.localeCompare(b.vaccineName);
      })
    : [];

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

      <h1>Ordering recommendations</h1>

      <p>
        <button
          style={styles.button}
          type="button"
          onClick={() => void loadRecommendation(session.accessToken)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {data && <p style={styles.muted}>{onHandStatusMessage(data.onHandLastReceivedAt)}</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.thRight}>Upcoming 7d</th>
            <th style={styles.th}>On hand</th>
            <th style={styles.thRight}>Recommended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vaccineId}>
              <td style={styles.td}>{row.vaccineName}</td>
              <td style={styles.tdRight}>{row.upcoming7d}</td>
              <td style={styles.td}>{onHandDisplay(row)}</td>
              <td style={styles.tdRight}>{row.recommendedOrder}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
