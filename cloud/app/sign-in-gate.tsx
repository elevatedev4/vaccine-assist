"use client";

import { useState, type FormEvent, type ReactNode } from "react";

/**
 * Shared "not signed in" screen (MSG-895, Will verbatim: "signin page
 * shouldn't have anything visible but the login form. Make it look
 * better and remove all the extra stuff (tabs).") — every cloud/ page
 * (appointments, ordering, data-entry, lots, settings, vaccines,
 * physicians) manages its own Supabase session independently and
 * previously rendered an identical, plain, top-left-aligned copy of
 * this form; this is that markup pulled into one place so the polish
 * only has to happen once and can't drift between pages.
 *
 * Auth logic (session handling/tokens) is unchanged — this component is
 * pure presentation. Callers still own `handleSignIn`, the email/
 * password state, and error/submitting flags exactly as before; this
 * just renders them consistently.
 *
 * `children`, when given, renders BELOW the sign-in card in its own
 * wider column — used only by the Settings page for its "Other
 * settings" links and desktop-install instructions, which are
 * deliberately shown even when signed out (see app/settings/sections.tsx's
 * doc comment: "neither needs auth").
 */
const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    padding: "3rem 1.25rem",
    fontFamily: "system-ui, sans-serif",
    background: "#f4f6f8",
    boxSizing: "border-box" as const,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    background: "#fff",
    border: "1px solid #e2e5e9",
    borderRadius: 8,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
    padding: "2rem",
    boxSizing: "border-box" as const,
  },
  brand: {
    margin: "0 0 0.25rem",
    fontSize: "0.8rem",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    color: "#0a58ca",
  },
  heading: {
    margin: "0 0 1.5rem",
    fontSize: "1.4rem",
  },
  field: { marginBottom: "1rem" },
  label: {
    display: "block",
    fontWeight: 600,
    fontSize: "0.85rem",
    marginBottom: "0.3rem",
  },
  input: {
    display: "block",
    width: "100%",
    padding: "0.55rem 0.65rem",
    fontSize: "1rem",
    border: "1px solid #c7ccd1",
    borderRadius: 4,
    boxSizing: "border-box" as const,
    outline: "none",
  },
  inputFocused: {
    borderColor: "#0a58ca",
    boxShadow: "0 0 0 3px rgba(10, 88, 202, 0.15)",
  },
  // Reserved height so an error message appearing/disappearing never
  // shifts the sign-in button up or down.
  errorSlot: { minHeight: "1.4rem", margin: "0 0 0.25rem" },
  error: { color: "#b00020", fontSize: "0.85rem", margin: 0 },
  button: {
    width: "100%",
    padding: "0.65rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    color: "#fff",
    background: "#0a58ca",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
  },
  buttonDisabled: {
    background: "#7fa3d9",
    cursor: "default",
  },
  extra: {
    width: "100%",
    maxWidth: 640,
    marginTop: "2rem",
  },
} as const;

type SignInGateProps = {
  /** Page-specific copy under the heading, e.g. "Use the shared pharmacy login to manage lots." */
  description: string;
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  error: string | null;
  submitting: boolean;
  children?: ReactNode;
};

export default function SignInGate({
  description,
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  error,
  submitting,
  children,
}: SignInGateProps) {
  const [focusedField, setFocusedField] = useState<"email" | "password" | null>(null);

  function inputStyle(field: "email" | "password") {
    return focusedField === field ? { ...styles.input, ...styles.inputFocused } : styles.input;
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <p style={styles.brand}>Vaccine Assist</p>
        <h1 style={styles.heading}>Sign in</h1>
        <form onSubmit={onSubmit}>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              style={inputStyle("email")}
              value={email}
              onChange={(e) => onEmailChange(e.target.value)}
              onFocus={() => setFocusedField("email")}
              onBlur={() => setFocusedField(null)}
              required
            />
          </div>
          <div style={styles.field}>
            <label style={styles.label} htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              style={inputStyle("password")}
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              onFocus={() => setFocusedField("password")}
              onBlur={() => setFocusedField(null)}
              required
            />
          </div>
          <div style={styles.errorSlot}>{error && <p style={styles.error}>{error}</p>}</div>
          <button
            style={submitting ? { ...styles.button, ...styles.buttonDisabled } : styles.button}
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p style={{ ...styles.label, fontWeight: 400, color: "#555", marginTop: "1.25rem", marginBottom: 0 }}>
          {description}
        </p>
      </div>
      {children && <div style={styles.extra}>{children}</div>}
    </main>
  );
}

/** Minimal, centered "checking session" placeholder shown while the
 * initial Supabase session lookup is in flight — kept in the same
 * vertically-centered shell as SignInGate so there's no layout jump
 * between "loading" and "sign in" for a signed-out visitor. */
export function AuthLoading() {
  return (
    <main style={{ ...styles.page, justifyContent: "center" }}>
      <p style={{ color: "#555" }}>Loading…</p>
    </main>
  );
}
