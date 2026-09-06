"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { isLotExpired } from "@/lib/vaccine-entry-payload";

/**
 * Web edition of the desktop app's Lots screen
 * (desktop/VaccineAssist.Desktop/Views/LotsView.xaml +
 * ViewModels/LotsViewModel.cs) — inventory + expirations, plus the
 * add-a-lot form staff use when a shipment comes in. Same GET/POST
 * /api/lots routes the desktop app already uses (no new API route
 * needed); the vaccine dropdown uses the default (active-only) GET
 * /api/vaccines, same as LotsViewModel.LoadAsync's GetVaccinesAsync.
 */

type VaccineOption = { id: string; name: string };

type LotRow = {
  id: string;
  vaccine_id: string;
  lot_number: string;
  expiration: string;
  status: string;
  note: string | null;
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
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
  formRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
    alignItems: "flex-end",
    padding: "0.75rem",
    marginBottom: "1rem",
    background: "#fafafa",
    border: "1px solid #ddd",
    borderRadius: 4,
  } as const,
  formField: { display: "flex", flexDirection: "column" as const, gap: "0.15rem" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  thCenter: { textAlign: "center", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdCenter: { textAlign: "center", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  expiredRow: { background: "#fde8e8" },
} as const;

export default function LotsPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineOption[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newVaccineId, setNewVaccineId] = useState("");
  const [newLotNumber, setNewLotNumber] = useState("");
  const [newExpiration, setNewExpiration] = useState("");
  const [newNote, setNewNote] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addOk, setAddOk] = useState(false);

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

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [vaccinesRes, lotsRes] = await Promise.all([
        fetch("/api/vaccines", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const vaccinesData = await vaccinesRes.json();
      const lotsData = await lotsRes.json();

      if (!vaccinesRes.ok) {
        setLoadError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }
      if (!lotsRes.ok) {
        setLoadError(lotsData.error ?? "Could not load lots.");
        return;
      }

      const loadedVaccines: VaccineOption[] = (vaccinesData.vaccines ?? [])
        .map((v: { id: string; name: string }) => ({ id: v.id, name: v.name }))
        .sort((a: VaccineOption, b: VaccineOption) => a.name.localeCompare(b.name));
      setVaccines(loadedVaccines);
      setNewVaccineId((current) => current || loadedVaccines[0]?.id || "");

      const loadedLots: LotRow[] = [...(lotsData.lots ?? [])].sort((a, b) =>
        a.expiration.localeCompare(b.expiration)
      );
      setLots(loadedLots);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load lots.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadAll(session.accessToken);
  }, [session, loadAll]);

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
      setLots([]);
      setLoadError(null);
      setAddError(null);
      setAddOk(false);
    }
  }

  async function handleAddLot(event: FormEvent) {
    event.preventDefault();
    if (!session || !newVaccineId || !newLotNumber.trim() || !newExpiration) return;

    setAdding(true);
    setAddError(null);
    setAddOk(false);
    try {
      const response = await fetch("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({
          vaccine_id: newVaccineId,
          lot_number: newLotNumber.trim(),
          expiration: newExpiration,
          note: newNote.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAddError(data.error ?? "Failed to add lot.");
        return;
      }
      setLots((prev) => [...prev, data.lot].sort((a, b) => a.expiration.localeCompare(b.expiration)));
      setNewLotNumber("");
      setNewNote("");
      setAddOk(true);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add lot.");
    } finally {
      setAdding(false);
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
        <p>Use the shared pharmacy login to manage lots.</p>
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

  const today = todayInChicago();
  const vaccineNameById = new Map(vaccines.map((v) => [v.id, v.name]));

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

      <h1>Lots</h1>
      <p style={styles.muted}>Inventory and expirations. Expired lots are highlighted below.</p>

      <p>
        <button style={styles.button} type="button" onClick={() => void loadAll(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}

      <form onSubmit={handleAddLot} style={styles.formRow}>
        <div style={styles.formField}>
          <label style={styles.label} htmlFor="newVaccine">
            Vaccine
          </label>
          <select id="newVaccine" value={newVaccineId} onChange={(e) => setNewVaccineId(e.target.value)} required>
            {vaccines.length === 0 && <option value="">No active vaccines</option>}
            {vaccines.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.formField}>
          <label style={styles.label} htmlFor="newLotNumber">
            Lot number
          </label>
          <input
            id="newLotNumber"
            type="text"
            value={newLotNumber}
            onChange={(e) => setNewLotNumber(e.target.value)}
            required
          />
        </div>
        <div style={styles.formField}>
          <label style={styles.label} htmlFor="newExpiration">
            Expiration
          </label>
          <input
            id="newExpiration"
            type="date"
            value={newExpiration}
            onChange={(e) => setNewExpiration(e.target.value)}
            required
          />
        </div>
        <div style={styles.formField}>
          <label style={styles.label} htmlFor="newNote">
            Note
          </label>
          <input id="newNote" type="text" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
        </div>
        <button style={styles.button} type="submit" disabled={adding || !newVaccineId}>
          {adding ? "Adding…" : "Add lot"}
        </button>
      </form>
      {addError && <p style={styles.error}>{addError}</p>}
      {addOk && <p style={styles.success}>Lot added.</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.th}>Lot number</th>
            <th style={styles.th}>Expiration</th>
            <th style={styles.thCenter}>Expired</th>
            <th style={styles.th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((lot) => {
            const expired = isLotExpired(lot.expiration, today);
            return (
              <tr key={lot.id} style={expired ? styles.expiredRow : undefined}>
                <td style={styles.td}>{vaccineNameById.get(lot.vaccine_id) ?? "(unknown vaccine)"}</td>
                <td style={styles.td}>{lot.lot_number}</td>
                <td style={styles.td}>{lot.expiration}</td>
                <td style={styles.tdCenter}>
                  <input type="checkbox" checked={expired} readOnly disabled />
                </td>
                <td style={styles.td}>{lot.note ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
