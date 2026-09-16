"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Settings → Sessions (V-sessions, Will 2026-09-13, verbatim): "include
 * a page in the cloud to manage these sessions and revoke them as
 * needed (ex: sign out everywhere button)." Lists every device signed
 * into the shared pharmacy login (GET /api/sessions), with a per-row
 * Revoke (DELETE /api/sessions/[id]) and a red "Sign out everywhere"
 * button (POST /api/sessions/sign-out-everywhere).
 *
 * There is no separate /login route anywhere in this app (see
 * app/sign-in-gate.tsx's doc comment) — every page renders its own
 * inline sign-in form when signed out via subscribeToSessionState, so
 * "redirects to login" after sign-out-everywhere means this page's own
 * SignInGate takes over once the local session clears, same as every
 * other sign-out in the app (see top-nav.tsx's handleSignOut).
 */

type ApiSession = {
  id: string;
  device: string;
  createdAt: string;
  lastActiveAt: string;
  isCurrent: boolean;
  /** V-sessions dedup (Will, 2026-09-16): a row here is really ONE
   * DEVICE, which may fold together several real Supabase sessions (the
   * desktop app signs in fresh on every launch — see
   * lib/session-grouping.ts). sessionCount/sessionIds let the Revoke
   * button act on the whole group with one click. */
  sessionCount: number;
  sessionIds: string[];
};

type SessionsResponse = { pending: true } | { sessions: ApiSession[] };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 760 },
  error: { color: "#b00020" },
  muted: { color: "#555", fontSize: "0.875rem" },
  section: { marginBottom: "2rem" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  badge: {
    display: "inline-block",
    marginLeft: "0.5rem",
    padding: "0.1rem 0.45rem",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#0a7d27",
    background: "#e7f7ea",
    border: "1px solid #bfe6c7",
    borderRadius: 999,
  },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  dangerButton: {
    padding: "0.5rem 1rem",
    background: "#b00020",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  },
  linkBack: { fontSize: "0.85rem" },
} as const;

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export default function SessionsPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [sessions, setSessions] = useState<ApiSession[] | null>(null);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  function resetAfterSignOut() {
    setSessions(null);
    setPending(false);
    setLoadError(null);
    setActionError(null);
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

  const loadSessions = useCallback(async (token: string) => {
    setLoadError(null);
    try {
      const response = await fetch("/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setLoadError("Could not load sessions.");
        return;
      }
      const data: SessionsResponse = await response.json();
      if ("pending" in data && data.pending) {
        setPending(true);
        setSessions(null);
        return;
      }
      setPending(false);
      setSessions("sessions" in data ? data.sessions : []);
    } catch {
      setLoadError("Could not load sessions.");
    }
  }, []);

  useEffect(() => {
    if (session) void loadSessions(session.accessToken);
  }, [session, loadSessions]);

  async function handleRevoke(target: ApiSession) {
    if (!session) return;
    const groupLabel = target.sessionCount > 1 ? `${target.device} (${target.sessionCount} sessions)` : target.device;
    if (
      !window.confirm(
        target.isCurrent
          ? "This is your current session — revoking it will sign you out here too. Continue?"
          : `Revoke ${groupLabel}?`
      )
    ) {
      return;
    }

    setActionError(null);
    setRevokingId(target.id);
    try {
      // A "device" row can fold together several real sessions (see
      // ApiSession's sessionIds doc comment) — revoke every one of them
      // so the group's Revoke button actually clears the whole device,
      // not just the most-recently-active session in it.
      for (const sessionId of target.sessionIds) {
        const response = await fetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setActionError(data.error ?? "Failed to revoke session.");
          return;
        }
      }
      if (target.isCurrent) {
        const supabase = getSupabaseBrowserClient();
        await supabase.auth.signOut();
        return;
      }
      await loadSessions(session.accessToken);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revoke session.");
    } finally {
      setRevokingId(null);
    }
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

  async function handleSignOutEverywhere() {
    if (!session) return;
    if (
      !window.confirm(
        "Sign out every device signed into this account, including this one? Everyone will need to log in again."
      )
    ) {
      return;
    }

    setActionError(null);
    setSigningOutEverywhere(true);
    try {
      const response = await fetch("/api/sessions/sign-out-everywhere", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setActionError(data.error ?? "Failed to sign out everywhere.");
        return;
      }
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to sign out everywhere.");
    } finally {
      setSigningOutEverywhere(false);
    }
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to manage sessions."
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

  return (
    <main style={styles.main}>
      <h1>Sessions</h1>
      <p style={styles.muted}>
        Every device currently signed into the shared pharmacy login. A device stays signed in for up to 90 days
        without needing to log in again — revoke a session here if a computer is lost, replaced, or no longer used.
      </p>
      <p style={styles.linkBack}>
        <a href="/settings">&larr; Back to Settings</a>
      </p>

      {/* Will, 2026-09-16 (verbatim): "Move the sign out everywhere
          button to the top." Same handler/confirm behavior as before —
          only its position moved, above the sessions list. */}
      <section style={styles.section}>
        <button type="button" style={styles.dangerButton} onClick={() => void handleSignOutEverywhere()} disabled={signingOutEverywhere}>
          {signingOutEverywhere ? "Signing out everywhere…" : "Sign out everywhere"}
        </button>
      </section>

      <section style={styles.section}>
        {loadError && <p style={styles.error}>{loadError}</p>}
        {actionError && <p style={styles.error}>{actionError}</p>}

        {pending && <p style={styles.muted}>Session management activates after the pending database migration.</p>}

        {!pending && sessions === null && !loadError && <p style={styles.muted}>Loading…</p>}

        {!pending && sessions !== null && sessions.length === 0 && <p style={styles.muted}>No active sessions.</p>}

        {!pending && sessions !== null && sessions.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Device</th>
                <th style={styles.th}>Signed in</th>
                <th style={styles.th}>Last active</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td style={styles.td}>
                    {s.device}
                    {s.sessionCount > 1 && <span style={styles.muted}> &nbsp;({s.sessionCount} sessions)</span>}
                    {s.isCurrent && <span style={styles.badge}>This device</span>}
                  </td>
                  <td style={styles.td}>{formatDateTime(s.createdAt)}</td>
                  <td style={styles.td}>{formatDateTime(s.lastActiveAt)}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.button} onClick={() => void handleRevoke(s)} disabled={revokingId === s.id}>
                      {revokingId === s.id ? "Revoking…" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
