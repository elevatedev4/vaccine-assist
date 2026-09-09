"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { isLotRowDue, pickCurrentActiveLot } from "@/lib/lots-table";
import { dedupeLotsByNumber, formatNdcDisplay } from "@/lib/lots-grouping";
import { buildProductViews, type ProductView } from "@/lib/product-view";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

/**
 * /lots page, round 3 (V-T-ordering-lots-round3, Will 2026-09-09
 * verbatim): "Make it much more compact. The table is wildly
 * inefficient. Remove explainer text and refresh button (there is
 * nothing to refresh here). Make sure the data on the ordering/lots page
 * matches (NDC, name, etc) and is consistent always. It should pull from
 * the same database. Beyond-use date only needs to apply to mNexspike
 * right now. Add a settings menu icon to the end of each row where you
 * can enable Beyond Use Date too. Put active/inactive in there. Follow
 * same groupings everywhere, including on lots, so put all Flu shots
 * together, COVID, then Other." Plus (4:29pm, verbatim): "Put COVID and
 * flu groups first, then other" (confirms the group order below) and
 * the expiration/beyond-use fields must be typed MM/DD/YYYY text, never
 * a native date-picker (see app/date-text-input.tsx).
 *
 * Rows/columns/fields:
 *   - One row per PRODUCT (lib/product-view.ts's buildProductViews —
 *     the SAME shared helper /ordering uses, so name/NDC/pkg-size/group
 *     are identical between the two pages, pulled from the same
 *     `vaccine` table).
 *   - Grouped COVID / Flu / Other (lib/ordering-group.ts, same order as
 *     Ordering), dark group-heading rows, no totals.
 *   - Compact spreadsheet styling matching Ordering's table (2px 6px
 *     padding, 13px font, thin 1px borders).
 *   - Columns: Product · NDC · Pkg size · Lot # · Expiration ·
 *     [Beyond-use date, only when enabled for that specific product] ·
 *     ⚙ (+ Save). The Active checkbox and Delete-lot button that used to
 *     sit in the row are now inside the ⚙ menu, alongside a new "Show
 *     beyond-use date" toggle.
 *   - Beyond-use-date enablement is a per-PRODUCT setting persisted
 *     server-side (GET/PUT /api/lots/settings, app_setting key
 *     `lots.bud_enabled_products`) — defaults to mNEXSPIKE only when
 *     nothing's been saved yet (lib/lots-settings.ts).
 *   - Inactive products stay listed under their group, greyed, sorted to
 *     the bottom of that group's rows (no separate collapsed section
 *     anymore).
 *
 * Saving/deleting a product row's lot still fans out server-side to
 * every dose vaccine_id in the group (POST/PATCH/DELETE /api/lots,
 * vaccine_ids / vaccineIds — see that route's own doc comment), and the
 * Active toggle still loops PATCH /api/vaccines/{id} across the group's
 * vaccine_ids client-side, both unchanged from before this round.
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

// Compact, spreadsheet-like styling — same numbers as the Ordering page
// (V-T-ordering-lots-round3: "Make it much more compact ... same as
// Ordering: 2px 6px padding, 13px, thin borders").
const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1100 },
  button: { padding: "0.3rem 0.7rem", fontSize: "13px" },
  error: { color: "#b00020", fontSize: "0.75rem" },
  success: { color: "#0a7d27", fontSize: "0.75rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#8a5300", fontSize: "0.8rem", fontStyle: "italic" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "13px", lineHeight: 1.2 },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  thRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  // Darkened heading (matches Ordering — Will, 2026-09-09: "Darken the
  // heading color to make it easier to distinguish").
  groupRow: { background: "#d9dde3", fontWeight: 600 },
  inactiveRow: { color: "#999" },
  input: { width: "100%", padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  dueRow: { background: "#fde8e8" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  // ⚙ settings menu — a native <details>/<summary> disclosure so no
  // extra click-outside-to-close JS is needed.
  menuDetails: { display: "inline-block", position: "relative" as const },
  menuSummary: { cursor: "pointer", listStyle: "none" as const, padding: "0 4px", border: "1px solid #ccc", borderRadius: 3 },
  menuPanel: {
    position: "absolute" as const,
    right: 0,
    top: "100%",
    zIndex: 10,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: 4,
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    padding: "0.5rem",
    minWidth: 170,
    whiteSpace: "nowrap" as const,
  },
  menuItem: { display: "block", padding: "0.2rem 0", fontSize: "13px" },
  menuItemButton: { display: "block", width: "100%", textAlign: "left" as const, padding: "0.2rem 0", fontSize: "13px", background: "none", border: "none", cursor: "pointer", color: "#b00020" },
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
  const [budEnabledKeys, setBudEnabledKeys] = useState<Set<string>>(new Set());

  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowSaved, setRowSaved] = useState<Record<string, boolean>>({});

  const [activeBusyKey, setActiveBusyKey] = useState<string | null>(null);
  const [activeErrorByKey, setActiveErrorByKey] = useState<Record<string, string>>({});
  const [budBusyKey, setBudBusyKey] = useState<string | null>(null);
  const [budErrorByKey, setBudErrorByKey] = useState<Record<string, string>>({});

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
    setBudErrorByKey({});
    setBudEnabledKeys(new Set());
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

  /** One draft per PRODUCT view. The group's "current" lot is
   * pickCurrentActiveLot over its lots deduped by lot_number
   * (dedupeLotsByNumber) — the union of every dose vaccine_id's lots,
   * collapsed back to the single value that's actually shown/edited. */
  function draftsFromProducts(views: ProductView[], lotList: LotRow[]): Record<string, RowDraft> {
    const next: Record<string, RowDraft> = {};
    for (const view of views) {
      const groupVaccineIds = new Set(view.vaccineIds);
      const groupLots = lotList.filter((l) => groupVaccineIds.has(l.vaccine_id));
      const current = pickCurrentActiveLot(dedupeLotsByNumber(groupLots));
      next[view.productKey] = {
        matchLotNumber: current?.lot_number ?? null,
        lotNumber: current?.lot_number ?? "",
        expiration: current?.expiration ?? "",
        beyondUseDate: current?.beyond_use_date ?? "",
      };
    }
    return next;
  }

  /** Vaccines grouped into one row per product (lib/product-view.ts's
   * SHARED buildProductViews — the same helper /ordering uses, so
   * name/NDC/pkg-size/group render identically on both pages) —
   * recomputed whenever `vaccines` changes rather than kept as separate
   * state, so it can never drift out of sync with the vaccine list it's
   * derived from. */
  const productViews = useMemo(() => buildProductViews(vaccines), [vaccines]);

  /** Groups product views into COVID/Flu/Other sections (same order
   * lib/ordering-group.ts's Ordering-tab display already uses), each
   * with active rows (alphabetical) first and inactive rows
   * (alphabetical, greyed) at the bottom — V-T-ordering-lots-round3:
   * "Inactive products still listed under their group but greyed ...
   * greyed rows at the bottom of each group." */
  const groupedProducts = useMemo(() => {
    const byGroup = new Map<string, ProductView[]>();
    for (const view of productViews) {
      const list = byGroup.get(view.group);
      if (list) list.push(view);
      else byGroup.set(view.group, [view]);
    }
    const order = ORDERING_GROUP_DISPLAY_ORDER.filter((group) => byGroup.has(group));
    for (const group of byGroup.keys()) {
      if (!order.includes(group)) order.push(group);
    }
    const byName = (a: ProductView, b: ProductView) => a.displayName.localeCompare(b.displayName);
    return order.map((group) => {
      const items = byGroup.get(group) ?? [];
      return {
        group,
        active: items.filter((v) => v.active).sort(byName),
        inactive: items.filter((v) => !v.active).sort(byName),
      };
    });
  }, [productViews]);

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [vaccinesRes, lotsRes, settingsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/lots/settings", { headers: { Authorization: `Bearer ${token}` } }),
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
      const loadedViews = buildProductViews(loadedVaccines);

      setVaccines(loadedVaccines);
      setLots(loadedLots);
      setDrafts(draftsFromProducts(loadedViews, loadedLots));
      setBeyondUseDateSupported(lotsData.beyondUseDateSupported !== false);

      // BUD enablement is a secondary setting — a failure here doesn't
      // block the page from showing lots/vaccines, it just falls back to
      // "nothing enabled" (no BUD field editable) until the next reload.
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setBudEnabledKeys(new Set<string>(settingsData.budEnabledProductKeys ?? []));
      } else {
        setBudEnabledKeys(new Set());
      }

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
   * Saves a product row's lot fields across EVERY dose vaccine_id in the
   * group, server-side (POST/PATCH /api/lots — see that route's doc
   * comment). No current lot yet (matchLotNumber null) creates one on
   * every vaccine_id at once; an existing lot is edited by matching its
   * OLD lot_number (draft.matchLotNumber, from before this edit) on
   * every vaccine_id, so a lot_number rename still finds the right row
   * on each dose.
   */
  async function handleSaveRow(view: ProductView) {
    if (!session) return;
    const draft = drafts[view.productKey];
    if (!draft || !draft.lotNumber.trim() || !draft.expiration) {
      setRowErrors((prev) => ({ ...prev, [view.productKey]: "Lot number and expiration are required." }));
      return;
    }

    setSavingKey(view.productKey);
    setRowErrors((prev) => ({ ...prev, [view.productKey]: "" }));
    setRowSaved((prev) => ({ ...prev, [view.productKey]: false }));
    try {
      const lotNumber = draft.lotNumber.trim();
      const response = await fetch("/api/lots", {
        method: draft.matchLotNumber ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(
          draft.matchLotNumber
            ? {
                vaccineIds: view.vaccineIds,
                matchLotNumber: draft.matchLotNumber,
                lot_number: lotNumber,
                expiration: draft.expiration,
                beyond_use_date: draft.beyondUseDate || null,
              }
            : {
                vaccine_ids: view.vaccineIds,
                lot_number: lotNumber,
                expiration: draft.expiration,
                beyond_use_date: draft.beyondUseDate || null,
              }
        ),
      });
      const data = await response.json();
      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [view.productKey]: data.error ?? "Failed to save lot." }));
        return;
      }

      if (data.beyondUseDateSupported === false) setBeyondUseDateSupported(false);

      const savedLots: LotRow[] = data.lots ?? [];
      const groupVaccineIds = new Set(view.vaccineIds);
      const oldLotNumber = draft.matchLotNumber;
      setLots((prev) => {
        const withoutOld = oldLotNumber
          ? prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === oldLotNumber))
          : prev;
        return [...withoutOld, ...savedLots];
      });
      setDrafts((prev) => ({
        ...prev,
        [view.productKey]: {
          matchLotNumber: lotNumber,
          lotNumber,
          expiration: draft.expiration,
          beyondUseDate: draft.beyondUseDate,
        },
      }));
      setRowSaved((prev) => ({ ...prev, [view.productKey]: true }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [view.productKey]: err instanceof Error ? err.message : "Failed to save lot." }));
    } finally {
      setSavingKey(null);
    }
  }

  /** Deletes a product row's current lot across every dose vaccine_id at
   * once (DELETE /api/lots, vaccineIds + lot_number). Only ever called
   * when draft.matchLotNumber is set (button is disabled otherwise) —
   * nothing to delete for a product with no lot yet. */
  async function handleDeleteRow(view: ProductView) {
    if (!session) return;
    const draft = drafts[view.productKey];
    if (!draft?.matchLotNumber) return;

    setSavingKey(view.productKey);
    setRowErrors((prev) => ({ ...prev, [view.productKey]: "" }));
    setRowSaved((prev) => ({ ...prev, [view.productKey]: false }));
    try {
      const response = await fetch("/api/lots", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ vaccineIds: view.vaccineIds, lot_number: draft.matchLotNumber }),
      });
      const data = await response.json();
      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [view.productKey]: data.error ?? "Failed to delete lot." }));
        return;
      }

      const groupVaccineIds = new Set(view.vaccineIds);
      const deletedLotNumber = draft.matchLotNumber;
      setLots((prev) => prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === deletedLotNumber)));
      setDrafts((prev) => ({
        ...prev,
        [view.productKey]: { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" },
      }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [view.productKey]: err instanceof Error ? err.message : "Failed to delete lot." }));
    } finally {
      setSavingKey(null);
    }
  }

  /** PATCH /api/vaccines/{id} {active} on EVERY dose vaccine_id in the
   * product — looped client-side (same per-vaccine endpoint the desktop
   * Active-vaccines tab already uses). Optimistic local update with
   * revert-on-failure, matching handleSaveRow's own busy/error pattern. */
  async function handleToggleActive(view: ProductView, nextActive: boolean) {
    if (!session) return;
    setActiveBusyKey(view.productKey);
    setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: "" }));
    try {
      const responses = await Promise.all(
        view.vaccineIds.map((vaccineId) =>
          fetch(`/api/vaccines/${vaccineId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
            body: JSON.stringify({ active: nextActive }),
          }).then(async (response) => ({ response, data: await response.json() }))
        )
      );
      const failed = responses.find(({ response }) => !response.ok);
      if (failed) {
        setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: failed.data.error ?? "Failed to update." }));
        return;
      }
      const groupVaccineIds = new Set(view.vaccineIds);
      setVaccines((prev) => prev.map((v) => (groupVaccineIds.has(v.id) ? { ...v, active: nextActive } : v)));
    } catch (err) {
      setActiveErrorByKey((prev) => ({ ...prev, [view.productKey]: err instanceof Error ? err.message : "Failed to update." }));
    } finally {
      setActiveBusyKey(null);
    }
  }

  /** PUT /api/lots/settings with this product's key added/removed from
   * the enabled list — optimistic local update on success, matching
   * handleToggleActive's own pattern. */
  async function handleToggleBud(view: ProductView, nextEnabled: boolean) {
    if (!session) return;
    setBudBusyKey(view.productKey);
    setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: "" }));
    const nextKeys = nextEnabled
      ? Array.from(new Set([...budEnabledKeys, view.productKey]))
      : Array.from(budEnabledKeys).filter((key) => key !== view.productKey);
    try {
      const response = await fetch("/api/lots/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ budEnabledProductKeys: nextKeys }),
      });
      const data = await response.json();
      if (!response.ok) {
        setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: data.error ?? "Failed to update." }));
        return;
      }
      setBudEnabledKeys(new Set<string>(data.budEnabledProductKeys ?? nextKeys));
    } catch (err) {
      setBudErrorByKey((prev) => ({ ...prev, [view.productKey]: err instanceof Error ? err.message : "Failed to update." }));
    } finally {
      setBudBusyKey(null);
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

  function renderProductRow(view: ProductView) {
    const draft = drafts[view.productKey] ?? { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" };
    const due = isLotRowDue(
      { expiration: draft.expiration || null, beyond_use_date: draft.beyondUseDate || null },
      today
    );
    const rowError = rowErrors[view.productKey];
    const saved = rowSaved[view.productKey];
    const saving = savingKey === view.productKey;
    const activeError = activeErrorByKey[view.productKey];
    const activeBusy = activeBusyKey === view.productKey;
    const budError = budErrorByKey[view.productKey];
    const budBusy = budBusyKey === view.productKey;
    const budEnabledForThisProduct = budEnabledKeys.has(view.productKey);

    const rowStyle = due ? styles.dueRow : view.active ? undefined : styles.inactiveRow;

    return (
      <tr key={view.productKey} style={rowStyle}>
        <td style={styles.td}>{view.displayName}</td>
        <td style={styles.td}>{formatNdcDisplay(view.ndc)}</td>
        <td style={styles.tdRight}>{view.packageSize ?? "—"}</td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="text"
            aria-label={`${view.displayName} lot number`}
            value={draft.lotNumber}
            onChange={(e) => updateDraft(view.productKey, { lotNumber: e.target.value })}
          />
        </td>
        <td style={styles.td}>
          <DateTextInput
            value={draft.expiration}
            ariaLabel={`${view.displayName} expiration`}
            onChange={(value) => updateDraft(view.productKey, { expiration: value })}
            style={styles.input}
          />
        </td>
        {beyondUseDateSupported && (
          <td style={styles.td}>
            {budEnabledForThisProduct ? (
              <DateTextInput
                value={draft.beyondUseDate}
                ariaLabel={`${view.displayName} beyond-use date`}
                onChange={(value) => updateDraft(view.productKey, { beyondUseDate: value })}
                style={styles.input}
              />
            ) : (
              <span style={styles.muted}>—</span>
            )}
          </td>
        )}
        <td style={styles.td}>
          <button style={styles.button} type="button" onClick={() => void handleSaveRow(view)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>{" "}
          <details style={styles.menuDetails}>
            <summary style={styles.menuSummary} aria-label={`${view.displayName} settings`}>
              ⚙
            </summary>
            <div style={styles.menuPanel}>
              <label style={styles.menuItem}>
                <input
                  type="checkbox"
                  aria-label={`${view.displayName} active`}
                  checked={view.active}
                  disabled={activeBusy}
                  onChange={(e) => void handleToggleActive(view, e.target.checked)}
                />{" "}
                Active
              </label>
              {beyondUseDateSupported && (
                <label style={styles.menuItem}>
                  <input
                    type="checkbox"
                    aria-label={`${view.displayName} show beyond-use date`}
                    checked={budEnabledForThisProduct}
                    disabled={budBusy}
                    onChange={(e) => void handleToggleBud(view, e.target.checked)}
                  />{" "}
                  Show beyond-use date
                </label>
              )}
              <button
                type="button"
                style={styles.menuItemButton}
                onClick={() => void handleDeleteRow(view)}
                disabled={saving || !draft.matchLotNumber}
              >
                Delete lot
              </button>
              {activeError && <div style={styles.error}>{activeError}</div>}
              {budError && <div style={styles.error}>{budError}</div>}
            </div>
          </details>
          {rowError && <div style={styles.error}>{rowError}</div>}
          {saved && !rowError && <div style={styles.success}>Saved.</div>}
        </td>
      </tr>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Lots</h1>

      {!beyondUseDateSupported && (
        <p style={styles.note}>Beyond-use date isn&apos;t available yet on this environment (pending migration).</p>
      )}

      {loadError && <p style={styles.error}>{loadError}</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Product</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.thRight}>Pkg size</th>
            <th style={styles.th}>Lot #</th>
            <th style={styles.th}>Expiration</th>
            {beyondUseDateSupported && <th style={styles.th}>Beyond-use date</th>}
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {groupedProducts.map(({ group, active, inactive }) => (
            <Fragment key={group}>
              <tr style={styles.groupRow}>
                <td style={styles.td}>{group}</td>
                <td style={styles.td}>—</td>
                <td style={styles.tdRight}>—</td>
                <td style={styles.td}>—</td>
                <td style={styles.td}>—</td>
                {beyondUseDateSupported && <td style={styles.td}>—</td>}
                <td style={styles.td}></td>
              </tr>
              {active.map(renderProductRow)}
              {inactive.map(renderProductRow)}
            </Fragment>
          ))}
        </tbody>
      </table>
    </main>
  );
}
