"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import {
  CONDITION_ITEMS,
  DEFAULT_CONDITIONS,
  DIABETES_SUB_KEYS,
  type ConditionKey,
  type PriorPneumoHistory,
  type ScreenerConditions,
} from "@/lib/screener-rules";
import { groupScreenerResults, screen } from "@/lib/screener";
import type { FormEvent } from "react";

/**
 * Vaccine eligibility SCREENER (V-screener, Will 2026-09-13 verbatim:
 * "I want to add a page that helps the pharmacist screen for vaccine
 * eligibility using these health conditions ... select the health
 * conditions the patient did and then be shown a list of eligible
 * vaccines ... also have a box to enter patient age too, since many
 * vaccines are simply based on age.").
 *
 * Same client-page shell as app/doses-given/page.tsx (SignInGate +
 * subscribeToSessionState + AuthLoading) for the shared pharmacy login,
 * but there is no API route here — every rule is code (lib/screener-
 * rules.ts) evaluated client-side by lib/screener.ts's pure `screen()`,
 * so results update live as the form changes with no network round
 * trip. Deliberately separate from the existing age-only eligibility
 * system (lib/eligibility.ts, app/api/eligibility/*) — see this page's
 * lib files for why.
 */

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem", fontSize: "0.78rem" },
  heading: { margin: "0.5rem 0 0.25rem", fontSize: "1.25rem" },
  note: {
    margin: "0 0 1rem",
    padding: "0.5rem 0.75rem",
    background: "#eef6ff",
    border: "1px solid #cfe3fb",
    borderRadius: 6,
    color: "#1a4971",
    fontSize: "0.72rem",
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 360px) 1fr",
    gap: "1.5rem",
    alignItems: "start",
  },
  formCard: {
    border: "1px solid #d5dce3",
    borderRadius: 8,
    padding: "0.9rem 1rem",
    background: "#fff",
  },
  ageRow: { display: "flex", flexDirection: "column" as const, gap: "0.25rem", marginBottom: "0.9rem" },
  label: { fontWeight: 600, fontSize: "0.75rem", color: "#222" },
  ageInput: {
    padding: "0.35rem 0.5rem",
    fontSize: "0.95rem",
    border: "1px solid #ccc",
    borderRadius: 4,
    width: "8rem",
  },
  ageHint: { fontSize: "0.68rem", color: "#666" },
  conditionsLegend: { fontWeight: 700, fontSize: "0.75rem", margin: "0 0 0.4rem", color: "#222" },
  conditionRow: { display: "flex", alignItems: "flex-start", gap: "0.4rem", padding: "0.15rem 0" },
  conditionRowIndent: { marginLeft: "1.25rem" },
  groupHeading: { fontSize: "0.68rem", fontWeight: 700, color: "#555", margin: "0.5rem 0 0.1rem 1.25rem" },
  checkbox: { marginTop: "0.15rem" },
  conditionLabel: { fontSize: "0.75rem", lineHeight: 1.3 },
  priorPneumoRow: { marginTop: "0.9rem", paddingTop: "0.7rem", borderTop: "1px solid #eee" },
  radioRow: { display: "flex", gap: "1rem", marginTop: "0.3rem" },
  radioLabel: { display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem" },
  clearButton: {
    marginTop: "1rem",
    padding: "0.4rem 0.9rem",
    fontSize: "0.75rem",
    cursor: "pointer",
    border: "1px solid #999",
    borderRadius: 4,
    background: "#fff",
  },
  resultsWrap: { display: "flex", flexDirection: "column" as const, gap: "1rem" },
  emptyState: { color: "#666", fontSize: "0.8rem" },
  group: { border: "1px solid #d5dce3", borderRadius: 8, overflow: "hidden" as const },
  groupHeader: {
    margin: 0,
    padding: "0.4rem 0.75rem",
    fontSize: "0.78rem",
    fontWeight: 700,
    background: "#f4f6f8",
    borderBottom: "1px solid #d5dce3",
  },
  resultRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "0.75rem",
    padding: "0.45rem 0.75rem",
    borderBottom: "1px solid #eee",
  },
  resultMain: { display: "flex", flexDirection: "column" as const, gap: "0.1rem" },
  resultName: { fontWeight: 700, fontSize: "0.8rem" },
  resultReason: { fontSize: "0.72rem", color: "#333" },
  resultSource: { fontSize: "0.68rem", color: "#1a6ecf", whiteSpace: "nowrap" as const },
} as const;

function statusGroupColor(status: string): string {
  switch (status) {
    case "routine":
      return "#e8f7ee";
    case "risk":
      return "#fff6e0";
    case "consider":
      return "#eef1fb";
    case "caution":
      return "#fdeaea";
    case "not-indicated":
      return "#f2f2f2";
    default:
      return "#f4f6f8";
  }
}

export default function ScreenerPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [ageInput, setAgeInput] = useState("");
  const [conditions, setConditions] = useState<ScreenerConditions>(DEFAULT_CONDITIONS);
  const [priorPneumo, setPriorPneumo] = useState<PriorPneumoHistory>("none");

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

  function toggleCondition(key: ConditionKey) {
    setConditions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Unchecking a diabetes sub-item never un-checks "Diabetes" itself
      // if the pharmacist explicitly checked it or another sub-item is
      // still checked — the parent stays whatever it was; the DERIVED
      // (rule-matching + display) value is recomputed by lib/screener.ts
      // and by the `diabetesChecked` memo below regardless.
      return next;
    });
  }

  function handleClear() {
    setAgeInput("");
    setConditions(DEFAULT_CONDITIONS);
    setPriorPneumo("none");
  }

  const diabetesSubChecked = DIABETES_SUB_KEYS.some((key) => conditions[key]);
  const ageValue = ageInput.trim() === "" ? null : Number(ageInput);
  const ageValid = ageValue !== null && Number.isFinite(ageValue) && ageValue >= 0 && ageValue <= 120;

  const groups = useMemo(() => {
    if (!ageValid || ageValue === null) return null;
    const results = screen(ageValue, conditions, priorPneumo);
    return groupScreenerResults(results);
  }, [ageValid, ageValue, conditions, priorPneumo]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to use the eligibility screener."
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
      <h1 style={styles.heading}>Vaccine eligibility screener</h1>
      <p style={styles.note}>
        Guidance current as of Sept 2026 (CDC/ACIP); verify before administering.
      </p>

      <div style={styles.columns}>
        <div style={styles.formCard}>
          <div style={styles.ageRow}>
            <label style={styles.label} htmlFor="screener-age">
              Age (years)
            </label>
            <input
              id="screener-age"
              type="number"
              min={0}
              max={120}
              step={0.1}
              autoFocus
              style={styles.ageInput}
              value={ageInput}
              onChange={(event) => setAgeInput(event.target.value)}
              placeholder="e.g. 55"
            />
            {ageValue !== null && ageValid && ageValue < 2 && (
              <span style={styles.ageHint}>≈ {Math.round(ageValue * 12)} months</span>
            )}
            {ageInput.trim() !== "" && !ageValid && (
              <span style={{ ...styles.ageHint, color: "#b00020" }}>Enter an age between 0 and 120.</span>
            )}
          </div>

          <p style={styles.conditionsLegend}>Health conditions</p>
          {CONDITION_ITEMS.map((item) => (
            <div key={item.key}>
              {item.groupHeading && <p style={styles.groupHeading}>{item.groupHeading}</p>}
              <label
                style={{
                  ...styles.conditionRow,
                  ...(item.indent ? styles.conditionRowIndent : {}),
                }}
              >
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={item.key === "diabetes" ? conditions.diabetes || diabetesSubChecked : conditions[item.key]}
                  onChange={() => toggleCondition(item.key)}
                />
                <span style={styles.conditionLabel}>{item.label}</span>
              </label>
            </div>
          ))}

          <div style={styles.priorPneumoRow}>
            <label style={styles.label} htmlFor="prior-pneumo-select">
              Prior pneumococcal vaccine history (Prevnar 20 / Capvaxive)
            </label>
            <select
              id="prior-pneumo-select"
              style={{ ...styles.ageInput, marginTop: "0.3rem" }}
              value={priorPneumo}
              onChange={(event) => setPriorPneumo(event.target.value as PriorPneumoHistory)}
            >
              <option value="none">None</option>
              <option value="pcv13">PCV13 only</option>
              <option value="ppsv23">PPSV23 only</option>
              <option value="both">Both PCV13 and PPSV23</option>
              <option value="pcv15_20_21">PCV15, PCV20, or PCV21 (series complete)</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>

          <button type="button" style={styles.clearButton} onClick={handleClear}>
            Clear
          </button>
        </div>

        <div style={styles.resultsWrap}>
          {!groups && <p style={styles.emptyState}>Enter a patient age to see recommendations.</p>}

          {groups &&
            groups.map((group) => (
              <div key={group.status} style={styles.group}>
                <h2 style={{ ...styles.groupHeader, background: statusGroupColor(group.status) }}>
                  {group.label}
                </h2>
                {group.results.map((result) => (
                  <div key={result.id} style={styles.resultRow}>
                    <div style={styles.resultMain}>
                      <span style={styles.resultName}>{result.name}</span>
                      <span style={styles.resultReason}>{result.reason}</span>
                    </div>
                    <a href={result.sourceUrl} target="_blank" rel="noreferrer" style={styles.resultSource}>
                      source
                    </a>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
    </main>
  );
}
