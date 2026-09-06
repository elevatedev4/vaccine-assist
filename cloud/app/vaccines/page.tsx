"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { formatCashPrice } from "@/lib/vaccine-entry-payload";

/**
 * Web edition of the desktop app's "Active vaccines" tab
 * (desktop/VaccineAssist.Desktop/Views/VaccinesView.xaml +
 * ViewModels/VaccinesViewModel.cs) — the whole formulary (active +
 * inactive), a read-only "Current lot" indicator, and an editable Active
 * toggle. Same "optimistic update, revert + surface error on failure"
 * semantics as VaccinesViewModel.OnActiveToggleRequested, and the same
 * PATCH /api/vaccines/[id] route the desktop app already uses (no new
 * API route needed).
 */

type VaccineRow = {
  id: string;
  name: string;
  short_code: string;
  dose: string | null;
  ndc: string | null;
  cash_price_cents: number | null;
  active: boolean;
  hasActiveLot: boolean;
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
  thCenter: { textAlign: "center", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdCenter: { textAlign: "center", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  inactiveRow: { color: "#888" },
} as const;

export default function VaccinesPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

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

  // Sorted active-first, then alphabetically — same order
  // VaccinesViewModel.LoadAsync builds.
  const sortVaccines = (rows: VaccineRow[]) =>
    [...rows].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const loadVaccines = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/vaccines?includeInactive=true", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setLoadError(data.error ?? "Could not load vaccines.");
        return;
      }
      setVaccines(sortVaccines(data.vaccines ?? []));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load vaccines.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadVaccines(session.accessToken);
  }, [session, loadVaccines]);

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
      setVaccines([]);
      setLoadError(null);
      setToggleError(null);
    }
  }

  // Optimistic toggle, revert on failure — same shape as
  // VaccineRowViewModel.Active's setter + VaccinesViewModel.OnActiveToggleRequested.
  async function handleToggleActive(row: VaccineRow, nextActive: boolean) {
    if (!session) return;
    setToggleError(null);
    setVaccines((prev) => sortVaccines(prev.map((v) => (v.id === row.id ? { ...v, active: nextActive } : v))));

    try {
      const response = await fetch(`/api/vaccines/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ active: nextActive }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to update vaccine.");
      }
    } catch (err) {
      setToggleError(`Couldn't update ${row.name}: ${err instanceof Error ? err.message : "unknown error"}`);
      // Revert.
      setVaccines((prev) => sortVaccines(prev.map((v) => (v.id === row.id ? { ...v, active: row.active } : v))));
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
        <p>Use the shared pharmacy login to view active vaccines.</p>
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

      <h1>Active vaccines</h1>
      <p style={styles.muted}>
        The full formulary. Toggling Active updates the catalog immediately — a failed toggle reverts itself and
        shows an error below.
      </p>

      <p>
        <button style={styles.button} type="button" onClick={() => void loadVaccines(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {toggleError && <p style={styles.error}>{toggleError}</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Name</th>
            <th style={styles.th}>Short code</th>
            <th style={styles.th}>Dose</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.th}>Cash price</th>
            <th style={styles.thCenter}>Current lot</th>
            <th style={styles.thCenter}>Active</th>
          </tr>
        </thead>
        <tbody>
          {vaccines.map((vaccine) => (
            <tr key={vaccine.id} style={vaccine.active ? undefined : styles.inactiveRow}>
              <td style={styles.td}>{vaccine.name}</td>
              <td style={styles.td}>{vaccine.short_code}</td>
              <td style={styles.td}>{vaccine.dose ?? "—"}</td>
              <td style={styles.td}>{vaccine.ndc ?? "—"}</td>
              <td style={styles.tdRight}>{formatCashPrice(vaccine.cash_price_cents)}</td>
              <td style={styles.tdCenter}>
                <input type="checkbox" checked={vaccine.hasActiveLot} readOnly disabled />
              </td>
              <td style={styles.tdCenter}>
                <input
                  type="checkbox"
                  checked={vaccine.active}
                  onChange={(e) => void handleToggleActive(vaccine, e.target.checked)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
