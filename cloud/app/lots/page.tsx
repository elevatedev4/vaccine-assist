"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { isLotRowDue, partitionVaccinesByActive, pickCurrentActiveLot } from "@/lib/lots-table";
import { dedupeLotsByNumber, formatNdcDisplay, groupVaccinesIntoProducts, type LotsProductGroup } from "@/lib/lots-grouping";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Rebuilt /lots page (V-cloud-tabs, Will 2026-09-05, third message):
 * "just a table with all the vaccines where you can update the lot /
 * expiration / beyond use date (optional) within the table. The row
 * should highlight if expired or beyond use date is met."
 *
 * V-T28 (Will 2026-09-09 verbatim: "Website lots, the app still shows
 * multiple lines for each vaccine (ex: Engerix-B, Gardasil). Similar to
 * the ordering logic, there should be one row per item and the NDC
 * should be displayed too."): rows are now one per PRODUCT, not one per
 * per-dose vaccine row — lib/lots-grouping.ts's groupVaccinesIntoProducts
 * collapses e.g. Gardasil's three dose rows into a single row keyed by
 * their shared NDC (or, for a dose with no NDC of its own like Vaqta's
 * second dose, by matching name). Each product row still edits ONE
 * current lot inline (lot number/expiration/beyond-use date, same
 * columns as before) — computed via pickCurrentActiveLot over the
 * group's lots deduped by lot_number (dedupeLotsByNumber), since the
 * lot-list apply script inserts the identical lot on every dose row and
 * this collapses those copies back to the one value being shown/edited.
 * Saving/deleting a product row's lot fans out server-side to every dose
 * vaccine_id in the group (POST/PATCH/DELETE /api/lots, vaccine_ids /
 * vaccineIds — see that route's own doc comment) rather than touching
 * only one dose, so the desktop guided data-entry flow (which still
 * reads per-dose lot rows) keeps seeing consistent data across doses.
 * The vaccine list itself (GET /api/vaccines?includeInactive=true) is
 * untouched — grouping is purely a display-layer computation over it.
 *
 * V-T21 item 4 (Will, 2026-09-08): active PRODUCTS are listed first;
 * inactive products get their own collapsed "Inactive vaccines (N)"
 * section BELOW (a native <details>, closed by default) so an inactive
 * product's row isn't just missing without explanation — and each row
 * (both sections) gets an Active checkbox (PATCH /api/vaccines/{id}
 * {active} for every dose vaccine_id in the product, looped client-side —
 * that per-vaccine endpoint already existed for the desktop
 * Active-vaccines tab, so no server change needed) so Will can
 * re-activate one later without leaving this page. Verified separately:
 * GET /api/eligibility/for-age (the data-entry popup's vaccine list) is
 * already `.eq("active", true)` — inactive vaccines already never show up
 * there, no fix needed on that side.
 */

type VaccineOption = { id: string; name: string; active: boolean; ndc: string | null };

type LotRow = {
  id: string;
  vaccine_id: string;
  lot_number: string;
  expiration: string;
  status: string;
  note: string | null;
  beyond_use_date?: string | null;
};

/**
 * Per-PRODUCT draft state — separate from the loaded LotRow so
 * in-progress edits don't get clobbered by a background refresh, and so
 * a brand-new (no lot yet) row has somewhere to hold its inputs before
 * the first save. `matchLotNumber` is the lot number as LOADED (before
 * any in-progress edit) — null means the product has no current lot yet
 * (Save will create one); non-null is what a Save/Delete's fan-out
 * request matches against on every dose vaccine_id, since the edited
 * `lotNumber` field itself may be a rename in flight.
 */
type RowDraft = { matchLotNumber: string | null; lotNumber: string; expiration: string; beyondUseDate: string };

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

  const [savingKey, setSavingKey] = useState<string | null>(null);
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
    setActiveErrorByKey({});
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

  /**
   * V-T28: one draft per PRODUCT group, not per vaccine. The group's
   * "current" lot is pickCurrentActiveLot over its lots deduped by
   * lot_number (dedupeLotsByNumber) — the union of every dose
   * vaccine_id's lots, collapsed back to the single value that's
   * actually shown/edited, so N identical dose-row copies (or, rarely, a
   * pre-fan-out drift between them) don't change which lot is picked.
   */
  function draftsFromProducts(groups: LotsProductGroup[], lotList: LotRow[]): Record<string, RowDraft> {
    const next: Record<string, RowDraft> = {};
    for (const group of groups) {
      const groupVaccineIds = new Set(group.vaccineIds);
      const groupLots = lotList.filter((l) => groupVaccineIds.has(l.vaccine_id));
      const current = pickCurrentActiveLot(dedupeLotsByNumber(groupLots));
      next[group.key] = {
        matchLotNumber: current?.lot_number ?? null,
        lotNumber: current?.lot_number ?? "",
        expiration: current?.expiration ?? "",
        beyondUseDate: current?.beyond_use_date ?? "",
      };
    }
    return next;
  }

  const [activeBusyKey, setActiveBusyKey] = useState<string | null>(null);
  const [activeErrorByKey, setActiveErrorByKey] = useState<Record<string, string>>({});

  /** V-T28: vaccines grouped into one row per product, sorted by display
   * name — recomputed whenever `vaccines` changes (e.g. after an Active
   * toggle) rather than kept as separate state, so it can never drift
   * out of sync with the vaccine list it's derived from. */
  const productGroups = useMemo(() => {
    return [...groupVaccinesIntoProducts(vaccines)].sort((a, b) => a.name.localeCompare(b.name));
  }, [vaccines]);

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

      const loadedVaccines: VaccineOption[] = (vaccinesData.vaccines ?? []).map(
        (v: { id: string; name: string; active: boolean; ndc: string | null }) => ({
          id: v.id,
          name: v.name,
          active: v.active,
          ndc: v.ndc ?? null,
        })
      );
      const loadedLots: LotRow[] = lotsData.lots ?? [];
      const loadedGroups = groupVaccinesIntoProducts(loadedVaccines);

      setVaccines(loadedVaccines);
      setLots(loadedLots);
      setDrafts(draftsFromProducts(loadedGroups, loadedLots));
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


  function updateDraft(key: string, patch: Partial<RowDraft>) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setRowSaved((prev) => ({ ...prev, [key]: false }));
  }

  /**
   * V-T28: saves a product row's lot fields across EVERY dose vaccine_id
   * in the group, server-side (POST/PATCH /api/lots — see that route's
   * doc comment). No current lot yet (matchLotNumber null) creates one
   * on every vaccine_id at once; an existing lot is edited by matching
   * its OLD lot_number (draft.matchLotNumber, from before this edit) on
   * every vaccine_id, so a lot_number rename still finds the right row
   * on each dose.
   */
  async function handleSaveRow(group: LotsProductGroup) {
    if (!session) return;
    const draft = drafts[group.key];
    if (!draft || !draft.lotNumber.trim() || !draft.expiration) {
      setRowErrors((prev) => ({ ...prev, [group.key]: "Lot number and expiration are required." }));
      return;
    }

    setSavingKey(group.key);
    setRowErrors((prev) => ({ ...prev, [group.key]: "" }));
    setRowSaved((prev) => ({ ...prev, [group.key]: false }));
    try {
      const lotNumber = draft.lotNumber.trim();
      const response = await fetch("/api/lots", {
        method: draft.matchLotNumber ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(
          draft.matchLotNumber
            ? {
                vaccineIds: group.vaccineIds,
                matchLotNumber: draft.matchLotNumber,
                lot_number: lotNumber,
                expiration: draft.expiration,
                beyond_use_date: draft.beyondUseDate || null,
              }
            : {
                vaccine_ids: group.vaccineIds,
                lot_number: lotNumber,
                expiration: draft.expiration,
                beyond_use_date: draft.beyondUseDate || null,
              }
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [group.key]: data.error ?? "Failed to save lot." }));
        return;
      }

      if (data.beyondUseDateSupported === false) setBeyondUseDateSupported(false);

      const savedLots: LotRow[] = data.lots ?? [];
      const groupVaccineIds = new Set(group.vaccineIds);
      const oldLotNumber = draft.matchLotNumber;
      setLots((prev) => {
        const withoutOld = oldLotNumber
          ? prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === oldLotNumber))
          : prev;
        return [...withoutOld, ...savedLots];
      });
      setDrafts((prev) => ({
        ...prev,
        [group.key]: {
          matchLotNumber: lotNumber,
          lotNumber,
          expiration: draft.expiration,
          beyondUseDate: draft.beyondUseDate,
        },
      }));
      setRowSaved((prev) => ({ ...prev, [group.key]: true }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [group.key]: err instanceof Error ? err.message : "Failed to save lot." }));
    } finally {
      setSavingKey(null);
    }
  }

  /** V-T28: deletes a product row's current lot across every dose
   * vaccine_id at once (DELETE /api/lots, vaccineIds + lot_number). Only
   * ever called when draft.matchLotNumber is set (button is disabled
   * otherwise) — nothing to delete for a product with no lot yet. */
  async function handleDeleteRow(group: LotsProductGroup) {
    if (!session) return;
    const draft = drafts[group.key];
    if (!draft?.matchLotNumber) return;

    setSavingKey(group.key);
    setRowErrors((prev) => ({ ...prev, [group.key]: "" }));
    setRowSaved((prev) => ({ ...prev, [group.key]: false }));
    try {
      const response = await fetch("/api/lots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ vaccineIds: group.vaccineIds, lot_number: draft.matchLotNumber }),
      });
      const data = await response.json();
      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [group.key]: data.error ?? "Failed to delete lot." }));
        return;
      }

      const groupVaccineIds = new Set(group.vaccineIds);
      const deletedLotNumber = draft.matchLotNumber;
      setLots((prev) => prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === deletedLotNumber)));
      setDrafts((prev) => ({
        ...prev,
        [group.key]: { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" },
      }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [group.key]: err instanceof Error ? err.message : "Failed to delete lot." }));
    } finally {
      setSavingKey(null);
    }
  }

  /** V-T21 item 4 / V-T28: PATCH /api/vaccines/{id} {active} on EVERY dose
   * vaccine_id in the product — same per-vaccine endpoint the desktop
   * Active-vaccines tab already uses, just looped client-side rather
   * than fanned out server-side (unlike the lot writes above, there's no
   * shared "match by value" ambiguity here — every id in the group gets
   * set to the same nextActive). Optimistic local update with
   * revert-on-failure, matching handleSaveRow's own busy/error pattern.
   */
  async function handleToggleActive(group: LotsProductGroup, nextActive: boolean) {
    if (!session) return;
    setActiveBusyKey(group.key);
    setActiveErrorByKey((prev) => ({ ...prev, [group.key]: "" }));
    try {
      const responses = await Promise.all(
        group.vaccineIds.map((vaccineId) =>
          fetch(`/api/vaccines/${vaccineId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
            body: JSON.stringify({ active: nextActive }),
          }).then(async (response) => ({ response, data: await response.json() }))
        )
      );
      const failed = responses.find(({ response }) => !response.ok);
      if (failed) {
        setActiveErrorByKey((prev) => ({ ...prev, [group.key]: failed.data.error ?? "Failed to update." }));
        return;
      }
      const groupVaccineIds = new Set(group.vaccineIds);
      setVaccines((prev) => prev.map((v) => (groupVaccineIds.has(v.id) ? { ...v, active: nextActive } : v)));
    } catch (err) {
      setActiveErrorByKey((prev) => ({ ...prev, [group.key]: err instanceof Error ? err.message : "Failed to update." }));
    } finally {
      setActiveBusyKey(null);
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
  const { active: activeProducts, inactive: inactiveProducts } = partitionVaccinesByActive(productGroups);

  /** V-T21 item 4 / V-T28: shared row renderer for both the active table
   * and the collapsed inactive section below — identical columns/
   * behavior in both. One row per PRODUCT group now (not per vaccine),
   * with an NDC column and a Delete-lot button alongside Save. */
  function renderProductRow(group: LotsProductGroup) {
    const draft = drafts[group.key] ?? { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" };
    const due = isLotRowDue(
      { expiration: draft.expiration || null, beyond_use_date: draft.beyondUseDate || null },
      today
    );
    const rowError = rowErrors[group.key];
    const saved = rowSaved[group.key];
    const saving = savingKey === group.key;
    const activeError = activeErrorByKey[group.key];
    const activeBusy = activeBusyKey === group.key;

    return (
      <tr key={group.key} style={due ? styles.dueRow : undefined}>
        <td style={styles.td}>{group.name}</td>
        <td style={styles.td}>{formatNdcDisplay(group.ndc)}</td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="text"
            aria-label={`${group.name} lot number`}
            value={draft.lotNumber}
            onChange={(e) => updateDraft(group.key, { lotNumber: e.target.value })}
          />
        </td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="date"
            aria-label={`${group.name} expiration`}
            value={draft.expiration}
            onChange={(e) => updateDraft(group.key, { expiration: e.target.value })}
          />
        </td>
        {beyondUseDateSupported && (
          <td style={styles.td}>
            <input
              style={styles.input}
              type="date"
              aria-label={`${group.name} beyond-use date`}
              value={draft.beyondUseDate}
              onChange={(e) => updateDraft(group.key, { beyondUseDate: e.target.value })}
            />
          </td>
        )}
        <td style={styles.td}>
          <label>
            <input
              type="checkbox"
              aria-label={`${group.name} active`}
              checked={group.active}
              disabled={activeBusy}
              onChange={(e) => void handleToggleActive(group, e.target.checked)}
            />{" "}
            Active
          </label>
          {activeError && <div style={styles.error}>{activeError}</div>}
        </td>
        <td style={styles.td}>
          <button style={styles.button} type="button" onClick={() => void handleSaveRow(group)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>{" "}
          <button
            style={styles.button}
            type="button"
            onClick={() => void handleDeleteRow(group)}
            disabled={saving || !draft.matchLotNumber}
          >
            Delete lot
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
        <th style={styles.th}>NDC</th>
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
        One row per product (a multi-dose series like Gardasil or Engerix collapses its dose rows into one, matched
        by NDC). Edit the lot number, expiration, and (optional) beyond-use date, then Save — the change applies to
        every dose of that product. A row highlights when its expiration or beyond-use date is today or already
        past. Uncheck Active to hide a product from data entry without losing its lot history; inactive products are
        listed below.
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
        <tbody>{activeProducts.map(renderProductRow)}</tbody>
      </table>

      <details style={{ marginTop: "1.5rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Inactive vaccines ({inactiveProducts.length})</summary>
        {inactiveProducts.length === 0 ? (
          <p style={styles.muted}>None.</p>
        ) : (
          <table style={{ ...styles.table, marginTop: "0.5rem" }}>
            {tableHead}
            <tbody>{inactiveProducts.map(renderProductRow)}</tbody>
          </table>
        )}
      </details>
    </main>
  );
}
