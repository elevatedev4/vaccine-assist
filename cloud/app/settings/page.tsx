"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { InstallDesktopAppSection, OtherSettingsLinks } from "@/app/settings/sections";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

type AcuityStatus = {
  configured: boolean;
  source: "database" | "env" | "none";
  acuityUserId: string | null;
  last4: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

type TestResult = { ok: boolean; message: string };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  muted: { color: "#555", fontSize: "0.875rem" },
  section: { marginBottom: "2rem" },
} as const;

export default function AcuitySettingsPage() {
  // Phase 1 has no browser sign-in flow anywhere else in the app (the
  // desktop app authenticates directly against Supabase and never
  // touches a browser) — this page needs one to call the auth-gated
  // settings API, so it's built minimally here: same single shared
  // pharmacy login (Supabase Auth, email/password), no separate accounts.
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [status, setStatus] = useState<AcuityStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setStatus(null);
    setStatusError(null);
    setUserIdInput("");
    setApiKeyInput("");
    setSaveError(null);
    setSaveOk(false);
    setTestResult(null);
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
      // Supabase not configured yet (phase 1) — stay signed out.
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  const loadStatus = useCallback(async (token: string) => {
    setStatusError(null);
    try {
      const response = await fetch("/api/settings/acuity", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setStatusError("Could not load the current Acuity status.");
        return;
      }
      const data: AcuityStatus = await response.json();
      setStatus(data);
      setUserIdInput(data.acuityUserId ?? "");
    } catch {
      setStatusError("Could not load the current Acuity status.");
    }
  }, []);

  useEffect(() => {
    if (session) void loadStatus(session.accessToken);
  }, [session, loadStatus]);

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

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    setTestResult(null);
    try {
      const response = await fetch("/api/settings/acuity", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ acuityUserId: userIdInput, acuityApiKey: apiKeyInput }),
      });
      const data = await response.json();
      if (!response.ok) {
        setSaveError(data.error ?? "Failed to save.");
        return;
      }
      setStatus(data);
      setApiKeyInput("");
      setSaveOk(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!session) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/settings/acuity/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ acuityUserId: userIdInput, acuityApiKey: apiKeyInput }),
      });
      const data: TestResult = await response.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Could not reach the server.",
      });
    } finally {
      setTesting(false);
    }
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to manage Acuity settings."
        email={signInEmail}
        password={signInPassword}
        onEmailChange={setSignInEmail}
        onPasswordChange={setSignInPassword}
        onSubmit={handleSignIn}
        error={signInError}
        submitting={signingIn}
      >
        <OtherSettingsLinks />
        <InstallDesktopAppSection />
      </SignInGate>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Settings</h1>

      <section style={styles.section}>
        <h2>Acuity Scheduling</h2>
        <p style={styles.muted}>
          Credentials are stored server-side and used only to poll appointment
          counts (no patient data is stored or displayed). The API key is
          never shown again after saving — only a status line confirming it&apos;s
          configured.
        </p>

      {statusError && <p style={styles.error}>{statusError}</p>}
      {status?.configured ? (
        <p>
          Status: configured &#10003; (last 4: &middot;&middot;&middot;&middot;
          {status.last4}
          {status.source === "env" ? ", from an environment variable" : ""})
        </p>
      ) : (
        <p>Status: not configured</p>
      )}

      <form onSubmit={handleSave}>
        <label style={styles.label} htmlFor="acuityUserId">
          Acuity User ID
        </label>
        <input
          id="acuityUserId"
          type="text"
          style={styles.field}
          value={userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          required
        />

        <label style={styles.label} htmlFor="acuityApiKey">
          Acuity API key
        </label>
        <input
          id="acuityApiKey"
          type="password"
          autoComplete="new-password"
          style={styles.field}
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder={status?.configured ? "Leave blank to keep the current key" : "Enter the Acuity API key"}
        />

        <button style={styles.button} type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button style={styles.button} type="button" onClick={() => void handleTest()} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
      </form>

      {saveError && <p style={styles.error}>{saveError}</p>}
      {saveOk && <p style={styles.success}>Saved.</p>}
      {testResult && (
        <p style={testResult.ok ? styles.success : styles.error}>
          {testResult.ok ? "✓ " : "✗ "}
          {testResult.message}
        </p>
      )}
      </section>

      <OtherSettingsLinks />
      <InstallDesktopAppSection />
    </main>
  );
}
