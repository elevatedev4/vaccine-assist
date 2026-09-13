"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import {
  buildDosesGivenPivot,
  dosesGivenPivotToCsv,
  productTotalsDescending,
  productTotalsToCsv,
  type DosesGivenPivot,
} from "@/lib/doses-given";

/**
 * Doses given explorer (V-doses-given, Will 2026-09-12 verbatim: "On the
 * scheduling page, include a data explorer link for doses given.") —
 * same look/pattern as the appointment Data Explorer
 * (app/appointments/explorer/page.tsx): a date-range picker, a pinned
 * loading bar, and CSV export. Data comes from GET
 * /api/administered/doses-given, which pivots lib/administered/store.ts's
 * per-day ingested dose rows into a day x product grid — see that
 * route's own doc comment. lib/doses-given.ts holds the pure pivot/CSV
 * logic (kept there, not inline here, same "pure + unit-tested" split
 * the explorer page's own doc comment describes for its own lib file).
 */

// Default range: last 14 COMPLETE Chicago days (today not yet finished,
// so it's excluded — same "until = yesterday" convention
// app/api/ordering/recommendation/route.ts uses for its given7d trend).
const DEFAULT_LOOKBACK_DAYS = 14;

type ViewMode = "byDay" | "byProduct";

function defaultRangeDates(): { start: string; end: string } {
  const end = addDaysToChicagoDate(todayInChicago(), -1);
  const start = addDaysToChicagoDate(end, -(DEFAULT_LOOKBACK_DAYS - 1));
  return { start, end };
}

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem", fontSize: "0.72rem" },
  heading: { margin: "0.5rem 0 0.5rem", fontSize: "1.25rem" },
  backLink: { fontSize: "0.8rem", margin: "0 0 0.75rem" },
  controlsRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "flex-end",
    gap: "0.9rem",
    margin: "0 0 0.75rem",
  },
  controlGroup: { display: "flex", flexDirection: "column" as const, gap: "0.2rem" },
  label: { fontWeight: 600, fontSize: "0.68rem", color: "#333" },
  input: { padding: "0.3rem 0.4rem", fontSize: "0.72rem", border: "1px solid #ccc", borderRadius: 3 },
  button: { padding: "0.35rem 0.8rem", fontSize: "0.72rem", cursor: "pointer" },
  toggleRow: { display: "flex", gap: "0.3rem" },
  toggleButton: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #999",
    background: "#fff",
    cursor: "pointer",
    borderRadius: 4,
  },
  toggleButtonActive: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #1e6b3a",
    background: "#16a34a",
    color: "#fff",
    cursor: "pointer",
    borderRadius: 4,
    fontWeight: 600,
  },
  error: { color: "#b00020" },
  muted: { color: "#555", fontSize: "0.72rem" },
  resultsAreaWrap: { position: "relative" as const },
  loadingOverlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    display: "flex",
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.8rem",
    background: "#fff",
    border: "1px solid #d5dce3",
    borderRadius: 6,
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
  },
  spinner: {
    width: "1.1rem",
    height: "1.1rem",
    borderRadius: "50%",
    border: "3px solid #d5dce3",
    borderTopColor: "#16a34a",
    animation: "doses-given-spin 0.7s linear infinite",
  },
  loadingLabel: { fontSize: "0.78rem", fontWeight: 600, color: "#333" },
  tableWrap: { overflowX: "auto" as const, maxWidth: "100%" },
  table: { borderCollapse: "collapse" as const, fontSize: "0.72rem", width: "100%" },
  th: {
    textAlign: "left" as const,
    padding: "0.2rem 0.4rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap" as const,
  },
  td: { padding: "0.15rem 0.4rem", borderBottom: "1px solid #eee", whiteSpace: "nowrap" as const },
  totalCell: { fontWeight: 700 },
  totalRow: { borderTop: "2px solid #ccc" },
} as const;

function formatAsOf(asOf: string | null): string {
  if (!asOf) return "";
  return new Date(asOf).toLocaleString();
}

export default function DosesGivenPage() {
  // Same shared-pharmacy-login session pattern as the appointment explorer.
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [draftStart, setDraftStart] = useState(() => defaultRangeDates().start);
  const [draftEnd, setDraftEnd] = useState(() => defaultRangeDates().end);
  const [appliedStart, setAppliedStart] = useState(() => defaultRangeDates().start);
  const [appliedEnd, setAppliedEnd] = useState(() => defaultRangeDates().end);

  const [pivot, setPivot] = useState<DosesGivenPivot | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("byDay");

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
        if (!state) {
          setPivot(null);
          setAsOf(null);
          setLoadError(null);
        }
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  const loadPivot = useCallback(async (token: string, start: string, end: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/administered/doses-given?start=${start}&end=${end}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setLoadError(data.error ?? "Could not load doses given data.");
        return;
      }
      const { start: _s, end: _e, asOf: responseAsOf, ...rest } = data;
      setPivot(rest as DosesGivenPivot);
      setAsOf(responseAsOf ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load doses given data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadPivot(session.accessToken, appliedStart, appliedEnd);
  }, [session, appliedStart, appliedEnd, loadPivot]);

  function handleApply() {
    setAppliedStart(draftStart);
    setAppliedEnd(draftEnd);
  }

  function handleRefresh() {
    if (session) void loadPivot(session.accessToken, appliedStart, appliedEnd);
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

  const productTotals = useMemo(() => (pivot ? productTotalsDescending(pivot) : []), [pivot]);

  function handleDownloadCsv() {
    if (!pivot) return;
    const csv = viewMode === "byDay" ? dosesGivenPivotToCsv(pivot) : productTotalsToCsv(pivot);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `doses_given_${appliedStart}_${appliedEnd}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to explore doses given."
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
      <style>{"@keyframes doses-given-spin { to { transform: rotate(360deg); } }"}</style>
      <h1 style={styles.heading}>Doses given</h1>
      <p style={styles.backLink}>
        <a href="/appointments">← Back to Schedule</a>
      </p>

      <div style={styles.controlsRow}>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="doses-given-start">
            Start
          </label>
          <input
            id="doses-given-start"
            type="date"
            style={styles.input}
            value={draftStart}
            onChange={(event) => setDraftStart(event.target.value)}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="doses-given-end">
            End
          </label>
          <input
            id="doses-given-end"
            type="date"
            style={styles.input}
            value={draftEnd}
            onChange={(event) => setDraftEnd(event.target.value)}
          />
        </div>
        <button type="button" style={styles.button} onClick={handleApply}>
          Apply
        </button>

        <div style={styles.controlGroup}>
          <span style={styles.label}>View</span>
          <div style={styles.toggleRow}>
            <button
              type="button"
              style={viewMode === "byDay" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setViewMode("byDay")}
              aria-pressed={viewMode === "byDay"}
            >
              By day
            </button>
            <button
              type="button"
              style={viewMode === "byProduct" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setViewMode("byProduct")}
              aria-pressed={viewMode === "byProduct"}
            >
              By product
            </button>
          </div>
        </div>

        <button type="button" style={styles.button} onClick={handleRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>

        <button type="button" style={styles.button} onClick={handleDownloadCsv} disabled={!pivot || pivot.grandTotal === 0}>
          Download CSV
        </button>

        {asOf && <span style={styles.muted}>Data as of {formatAsOf(asOf)}</span>}
      </div>

      {loadError && <p style={styles.error}>{loadError}</p>}

      <div style={styles.resultsAreaWrap}>
        {loading && (
          <div style={styles.loadingOverlay} role="status" aria-live="polite">
            <span style={styles.spinner} aria-hidden="true" />
            <span style={styles.loadingLabel}>Loading…</span>
          </div>
        )}
        <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms ease" }}>
          {pivot && pivot.grandTotal === 0 && !loadError && (
            <p style={styles.muted}>No doses given found in this range.</p>
          )}

          {pivot && pivot.grandTotal > 0 && viewMode === "byDay" && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Date</th>
                    {pivot.products.map((product) => (
                      <th key={product} style={styles.th}>
                        {product}
                      </th>
                    ))}
                    <th style={styles.th}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pivot.dates.map((date) => (
                    <tr key={date}>
                      <td style={styles.td}>{date}</td>
                      {pivot.products.map((product) => (
                        <td key={product} style={styles.td}>
                          {pivot.countsByDateProduct[date][product]}
                        </td>
                      ))}
                      <td style={{ ...styles.td, ...styles.totalCell }}>{pivot.totalsByDate[date]}</td>
                    </tr>
                  ))}
                  <tr style={styles.totalRow}>
                    <td style={{ ...styles.td, ...styles.totalCell }}>Total</td>
                    {pivot.products.map((product) => (
                      <td key={product} style={{ ...styles.td, ...styles.totalCell }}>
                        {pivot.totalsByProduct[product]}
                      </td>
                    ))}
                    <td style={{ ...styles.td, ...styles.totalCell }}>{pivot.grandTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {pivot && pivot.grandTotal > 0 && viewMode === "byProduct" && (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Product</th>
                    <th style={styles.th}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {productTotals.map(({ product, total }) => (
                    <tr key={product}>
                      <td style={styles.td}>{product}</td>
                      <td style={styles.td}>{total}</td>
                    </tr>
                  ))}
                  <tr style={styles.totalRow}>
                    <td style={{ ...styles.td, ...styles.totalCell }}>Total</td>
                    <td style={{ ...styles.td, ...styles.totalCell }}>{pivot.grandTotal}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
