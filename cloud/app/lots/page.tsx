"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { isLotRowDue, partitionVaccinesByActive, pickCurrentActiveLot } from "@/lib/lots-table";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Rebuilt /lots page (V-cloud-tabs, Will 2026-09-05, third message):
 * "just a table with all the vaccines where you can update the lot /
 * expiration / beyond use date (optional) within the table. The row
 * should highlight if expired or beyond use date is met."
 *
 * ONE row per vaccine (from GET /api/vaccines?includeInactive=true — the
 * admin/full list, same one the desktop Active-vaccines tab uses). Each
 * row shows/edits that vaccine's CURRENT active lot (lib/lots-table.ts's
 * pickCurrentActiveLot) inline: lot number, expiration, and an optional
 * beyond-use date. A per-row "Save" button (JUDGMENT CALL: explicit
 * button over save-on-blur — blur is easy to trigger accidentally while
 * tabbing between fields, and an explicit button gives a clear "did this
 * save" moment plus somewhere to show a per-row error) PATCHes the
 * vaccine's existing lot, or POSTs a new one if it doesn't have one yet.
 *
 * V-T21 item 4 (Will, 2026-09-08): active vaccines are listed first;
 * inactive vaccines get their own collapsed "Inactive vaccines (N)"
 * section BELOW (a native <details>, closed by default) so an inactive
 * product's row isn't just missing without explanation — and each row
 * (both sections) gets an Active checkbox (PATCH /api/vaccines/{id}
 * {active}, already used by the desktop Active-vaccines tab) so Will can
 * re-activate one later without leaving this page. Verified separately:
 * GET /api/eligibility/for-age (the data-entry popup's vaccine list) is
 * already `.eq("active", true)` — inactive vaccines already never show up
 * there, no fix needed on that side.
 */

type VaccineOption = { id: string; name: string; active: boolean };

type LotRow = {
  id: string;
  vaccine_id: string;
  lot_number: string;
  expiration: string;
  status: string;
  note: string | null;
  beyond_use_date?: string | null;
};

/** Per-row draft state — separate from the loaded LotRow so in-progress edits don't get clobbered by a background refresh, and so a brand-new (no lot yet) row has somewhere to hold its inputs before the first save. */
type RowDraft = { lotId: string | null; lotNumber: string; expiration: string; beyondUseDate: string };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 960 },
  button: { padding: "0.4rem 0.9rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#8a5300", fontSize: "0.8rem", fontStyle: "italic" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "1px solid #eee" },
  input: { width: "100%", padding: "0.3rem", boxSizing: "border-box" as const },
  dueRow: { background: "#fde8e8" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
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
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [beyondUseDateSupported, setBeyondUseDateSupported] = useState(true);

  const [savingVaccineId, setSavingVaccineId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowSaved, setRowSaved] = useState<Record<string, boolean>>({});

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setDrafts({});
    setLoadError(null);
    setActiveErrorById({});
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

  function draftsFromLots(vaccineList: VaccineOption[], lotList: LotRow[]): Record<string, RowDraft> {
    const next: Record<string, RowDraft> = {};
    for (const vaccine of vaccineList) {
      const vaccineLots = lotList.filter((l) => l.vaccine_id === vaccine.id);
      const current = pickCurrentActiveLot(vaccineLots);
      next[vaccine.id] = {
        lotId: current?.id ?? null,
        lotNumber: current?.lot_number ?? "",
        expiration: current?.expiration ?? "",
        beyondUseDate: current?.beyond_use_date ?? "",
      };
    }
    return next;
  }

  const [activeBusyId, setActiveBusyId] = useState<string | null>(null);
  const [activeErrorById, setActiveErrorById] = useState<Record<string, string>>({});

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [vaccinesRes, lotsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers: { Authorization: `Bearer ${token}` } }),
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
        .map((v: { id: string; name: string; active: boolean }) => ({ id: v.id, name: v.name, active: v.active }))
        .sort((a: VaccineOption, b: VaccineOption) => a.name.localeCompare(b.name));
      const loadedLots: LotRow[] = lotsData.lots ?? [];

      setVaccines(loadedVaccines);
      setLots(loadedLots);
      setDrafts(draftsFromLots(loadedVaccines, loadedLots));
      setBeyondUseDateSupported(lotsData.beyondUseDateSupported !== false);
      setRowErrors({});
      setRowSaved({});
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


  function updateDraft(vaccineId: string, patch: Partial<RowDraft>) {
    setDrafts((prev) => ({ ...prev, [vaccineId]: { ...prev[vaccineId], ...patch } }));
    setRowSaved((prev) => ({ ...prev, [vaccineId]: false }));
  }

  async function handleSaveRow(vaccineId: string) {
    if (!session) return;
    const draft = drafts[vaccineId];
    if (!draft || !draft.lotNumber.trim() || !draft.expiration) {
      setRowErrors((prev) => ({ ...prev, [vaccineId]: "Lot number and expiration are required." }));
      return;
    }

    setSavingVaccineId(vaccineId);
    setRowErrors((prev) => ({ ...prev, [vaccineId]: "" }));
    setRowSaved((prev) => ({ ...prev, [vaccineId]: false }));
    try {
      const payload: Record<string, unknown> = {
        lot_number: draft.lotNumber.trim(),
        expiration: draft.expiration,
        beyond_use_date: draft.beyondUseDate || null,
      };

      const response = await fetch(
        draft.lotId ? `/api/lots/${draft.lotId}` : "/api/lots",
        draft.lotId
          ? {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
              body: JSON.stringify(payload),
            }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
              body: JSON.stringify({ vaccine_id: vaccineId, ...payload }),
            }
      );
      const data = await response.json();
      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [vaccineId]: data.error ?? "Failed to save lot." }));
        return;
      }

      if (data.beyondUseDateSupported === false) setBeyondUseDateSupported(false);

      const savedLot: LotRow = data.lot;
      setLots((prev) => {
        const withoutOld = draft.lotId ? prev.filter((l) => l.id !== draft.lotId) : prev;
        return [...withoutOld, savedLot];
      });
      setDrafts((prev) => ({
        ...prev,
        [vaccineId]: {
          lotId: savedLot.id,
          lotNumber: savedLot.lot_number,
          expiration: savedLot.expiration,
          beyondUseDate: savedLot.beyond_use_date ?? "",
        },
      }));
      setRowSaved((prev) => ({ ...prev, [vaccineId]: true }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [vaccineId]: err instanceof Error ? err.message : "Failed to save lot." }));
    } finally {
      setSavingVaccineId(null);
    }
  }

  /** V-T21 item 4: PATCH /api/vaccines/{id} {active} — same write path the
   * desktop Active-vaccines tab already uses. Optimistic local update with
   * revert-on-failure, matching handleSaveRow's own busy/error pattern. */
  async function handleToggleActive(vaccineId: string, nextActive: boolean) {
    if (!session) return;
    setActiveBusyId(vaccineId);
    setActiveErrorById((prev) => ({ ...prev, [vaccineId]: "" }));
    try {
      const response = await fetch(`/api/vaccines/${vaccineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ active: nextActive }),
      });
      const data = await response.json();
      if (!response.ok) {
        setActiveErrorById((prev) => ({ ...prev, [vaccineId]: data.error ?? "Failed to update." }));
        return;
      }
      setVaccines((prev) => prev.map((v) => (v.id === vaccineId ? { ...v, active: nextActive } : v)));
    } catch (err) {
      setActiveErrorById((prev) => ({ ...prev, [vaccineId]: err instanceof Error ? err.message : "Failed to update." }));
    } finally {
      setActiveBusyId(null);
    }
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to manage lots."
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

  const today = todayInChicago();
  const { active: activeVaccines, inactive: inactiveVaccines } = partitionVaccinesByActive(vaccines);

  /** V-T21 item 4: shared row renderer for both the active table and the
   * collapsed inactive section below — identical columns/behavior in
   * both, plus the Active checkbox every row now gets. */
  function renderVaccineRow(vaccine: VaccineOption) {
    const draft = drafts[vaccine.id] ?? { lotId: null, lotNumber: "", expiration: "", beyondUseDate: "" };
    const due = isLotRowDue(
      { expiration: draft.expiration || null, beyond_use_date: draft.beyondUseDate || null },
      today
    );
    const rowError = rowErrors[vaccine.id];
    const saved = rowSaved[vaccine.id];
    const saving = savingVaccineId === vaccine.id;
    const activeError = activeErrorById[vaccine.id];
    const activeBusy = activeBusyId === vaccine.id;

    return (
      <tr key={vaccine.id} style={due ? styles.dueRow : undefined}>
        <td style={styles.td}>{vaccine.name}</td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="text"
            aria-label={`${vaccine.name} lot number`}
            value={draft.lotNumber}
            onChange={(e) => updateDraft(vaccine.id, { lotNumber: e.target.value })}
          />
        </td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="date"
            aria-label={`${vaccine.name} expiration`}
            value={draft.expiration}
            onChange={(e) => updateDraft(vaccine.id, { expiration: e.target.value })}
          />
        </td>
        {beyondUseDateSupported && (
          <td style={styles.td}>
            <input
              style={styles.input}
              type="date"
              aria-label={`${vaccine.name} beyond-use date`}
              value={draft.beyondUseDate}
              onChange={(e) => updateDraft(vaccine.id, { beyondUseDate: e.target.value })}
            />
          </td>
        )}
        <td style={styles.td}>
          <label>
            <input
              type="checkbox"
              aria-label={`${vaccine.name} active`}
              checked={vaccine.active}
              disabled={activeBusy}
              onChange={(e) => void handleToggleActive(vaccine.id, e.target.checked)}
            />{" "}
            Active
          </label>
          {activeError && <div style={styles.error}>{activeError}</div>}
        </td>
        <td style={styles.td}>
          <button style={styles.button} type="button" onClick={() => void handleSaveRow(vaccine.id)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          {rowError && <div style={styles.error}>{rowError}</div>}
          {saved && !rowError && <div style={styles.success}>Saved.</div>}
        </td>
      </tr>
    );
  }

  const tableHead = (
    <thead>
      <tr>
        <th style={styles.th}>Vaccine</th>
        <th style={styles.th}>Lot number</th>
        <th style={styles.th}>Expiration</th>
        {beyondUseDateSupported && <th style={styles.th}>Beyond-use date (optional)</th>}
        <th style={styles.th}>Active</th>
        <th style={styles.th}></th>
      </tr>
    </thead>
  );

  return (
    <main style={styles.main}>
      <h1>Lots</h1>
      <p style={styles.muted}>
        One row per vaccine. Edit the lot number, expiration, and (optional) beyond-use date, then Save. A row
        highlights when its expiration or beyond-use date is today or already past. Uncheck Active to hide a vaccine
        from data entry without losing its lot history; inactive vaccines are listed below.
      </p>
      {!beyondUseDateSupported && (
        <p style={styles.note}>Beyond-use date isn&apos;t available yet on this environment (pending migration).</p>
      )}

      <p>
        <button style={styles.button} type="button" onClick={() => void loadAll(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}

      <table style={styles.table}>
        {tableHead}
        <tbody>{activeVaccines.map(renderVaccineRow)}</tbody>
      </table>

      <details style={{ marginTop: "1.5rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Inactive vaccines ({inactiveVaccines.length})</summary>
        {inactiveVaccines.length === 0 ? (
          <p style={styles.muted}>None.</p>
        ) : (
          <table style={{ ...styles.table, marginTop: "0.5rem" }}>
            {tableHead}
            <tbody>{inactiveVaccines.map(renderVaccineRow)}</tbody>
          </table>
        )}
      </details>
    </main>
  );
}
