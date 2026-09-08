"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { formatCashPrice } from "@/lib/vaccine-entry-payload";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Web edition of the desktop app's "Active vaccines" tab
 * (desktop/VaccineAssist.Desktop/Views/VaccinesView.xaml +
 * ViewModels/VaccinesViewModel.cs) — the whole formulary (active +
 * inactive), a read-only "Current lot" indicator, and an editable Active
 * toggle. Same "optimistic update, revert + surface error on failure"
 * semantics as VaccinesViewModel.OnActiveToggleRequested, and the same
 * PATCH /api/vaccines/[id] route the desktop app already uses (no new
 * API route needed).
 *
 * V-cloud-tabs (Will, 2026-09-05/07, item G): also exposes editable
 * `quantity`/`directions` columns — Pioneer prescription-entry defaults
 * feeding the desktop app's entry flow later. Plumbing only per Will's
 * brief: no defaults are invented here, staff/Will fill these in. These
 * are additive columns (supabase/migrations/0009_lots_bud_vaccine_defaults.sql)
 * that may not exist yet — GET /api/vaccines reports
 * `quantityDirectionsSupported`, and when false the columns are hidden
 * with a "pending migration" note instead of rendering broken inputs.
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
  quantity?: string | null;
  directions?: string | null;
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  muted: { color: "#555", fontSize: "0.875rem" },
  pendingNote: { color: "#8a5300", fontSize: "0.8rem", fontStyle: "italic" },
  fieldInput: { width: "100%", padding: "0.3rem", boxSizing: "border-box" as const },
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
  const [quantityDirectionsSupported, setQuantityDirectionsSupported] = useState(true);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, { quantity: string; directions: string }>>({});
  const [savingField, setSavingField] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setVaccines([]);
    setLoadError(null);
    setToggleError(null);
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
      const loaded: VaccineRow[] = sortVaccines(data.vaccines ?? []);
      setVaccines(loaded);
      setQuantityDirectionsSupported(data.quantityDirectionsSupported !== false);
      setFieldDrafts(
        Object.fromEntries(
          loaded.map((v) => [v.id, { quantity: v.quantity ?? "", directions: v.directions ?? "" }])
        )
      );
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

  function updateFieldDraft(vaccineId: string, patch: Partial<{ quantity: string; directions: string }>) {
    setFieldDrafts((prev) => ({ ...prev, [vaccineId]: { ...prev[vaccineId], ...patch } }));
  }

  async function handleSaveFields(row: VaccineRow) {
    if (!session) return;
    const draft = fieldDrafts[row.id] ?? { quantity: "", directions: "" };
    setSavingField(row.id);
    setFieldErrors((prev) => ({ ...prev, [row.id]: "" }));
    try {
      const response = await fetch(`/api/vaccines/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ quantity: draft.quantity || null, directions: draft.directions || null }),
      });
      const data = await response.json();
      if (!response.ok) {
        setFieldErrors((prev) => ({ ...prev, [row.id]: data.error ?? "Failed to save." }));
        return;
      }
      if (data.quantityDirectionsSupported === false) setQuantityDirectionsSupported(false);
      setVaccines((prev) =>
        sortVaccines(
          prev.map((v) => (v.id === row.id ? { ...v, quantity: data.vaccine?.quantity, directions: data.vaccine?.directions } : v))
        )
      );
    } catch (err) {
      setFieldErrors((prev) => ({ ...prev, [row.id]: err instanceof Error ? err.message : "Failed to save." }));
    } finally {
      setSavingField(null);
    }
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view active vaccines."
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
      {!quantityDirectionsSupported && (
        <p style={styles.pendingNote}>Quantity/Directions aren&apos;t available yet on this environment (pending migration).</p>
      )}

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
            {quantityDirectionsSupported && <th style={styles.th}>Quantity</th>}
            {quantityDirectionsSupported && <th style={styles.th}>Directions</th>}
            {quantityDirectionsSupported && <th style={styles.th}></th>}
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
              {quantityDirectionsSupported && (
                <td style={styles.td}>
                  <input
                    style={styles.fieldInput}
                    type="text"
                    aria-label={`${vaccine.name} quantity`}
                    value={fieldDrafts[vaccine.id]?.quantity ?? ""}
                    onChange={(e) => updateFieldDraft(vaccine.id, { quantity: e.target.value })}
                  />
                </td>
              )}
              {quantityDirectionsSupported && (
                <td style={styles.td}>
                  <input
                    style={styles.fieldInput}
                    type="text"
                    aria-label={`${vaccine.name} directions`}
                    value={fieldDrafts[vaccine.id]?.directions ?? ""}
                    onChange={(e) => updateFieldDraft(vaccine.id, { directions: e.target.value })}
                  />
                </td>
              )}
              {quantityDirectionsSupported && (
                <td style={styles.td}>
                  <button
                    style={styles.button}
                    type="button"
                    onClick={() => void handleSaveFields(vaccine)}
                    disabled={savingField === vaccine.id}
                  >
                    {savingField === vaccine.id ? "Saving…" : "Save"}
                  </button>
                  {fieldErrors[vaccine.id] && <div style={styles.error}>{fieldErrors[vaccine.id]}</div>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
