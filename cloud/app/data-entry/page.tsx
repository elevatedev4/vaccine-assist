"use client";

import { useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { DataEntryInstructions } from "@/app/data-entry/instructions";

/**
 * V-cloud-tabs (Will, 2026-09-05, second message): "no web data-entry
 * capability — just instructions: launch the Vaccine Assist desktop app
 * and press Ctrl+Keypad2 from the patient's Rx Profile." This REPLACES
 * the previous guided web flow entirely (age -> group -> product ->
 * dose -> clipboard payload) — that flow is gone, not hidden behind a
 * flag, per Will's explicit "no web data-entry capability" instruction.
 * Data entry now only happens through the desktop app's own popup
 * (desktop/VaccineAssist.Desktop/ViewModels/DataEntryPopupViewModel.cs),
 * launched from inside PioneerRx's Rx Profile screen.
 */

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem", marginBottom: "0.5rem" },
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
} as const;

export default function DataEntryPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

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
        <p>Use the shared pharmacy login to view data-entry instructions.</p>
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

      <DataEntryInstructions />
    </main>
  );
}
