"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { isLotRowDue, pickCurrentActiveLot, resolveLotRowHighlight } from "@/lib/lots-table";
import { dedupeLotsByNumber, partitionProductsForLotsPage } from "@/lib/lots-grouping";
import { buildProductViews, type ProductView } from "@/lib/product-view";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { formatNdcDashed } from "@/lib/ndc";
import { isoToMaskedDate } from "@/lib/date-mask";
import { createDebouncedRunner, decideDateAutosave, decideLotNumberAutosave, type DebouncedRunner } from "@/lib/lots-autosave";
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
 *   - Columns: Product · NDC · Units/pkg (renamed from "Pkg size",
 *     V-onhand-ndc-units — value unchanged, still the catalog's static
 *     dosesPerPackage) · Lot # · Expiration ·
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

// V-T-ordering-lots-round4 (Will: "autosave anytime new typing occurs")
// — how long a row's fields must sit idle before an autosave fires.
const AUTOSAVE_DEBOUNCE_MS = 600;

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
  // The draft snapshot as last confirmed PERSISTED (loaded from the
  // server, or a successful autosave) — compared against the live
  // `drafts` entry by lib/lots-autosave.ts's decide* functions to tell
  // "changed since last save" from "debounce refired with nothing new."
  const [lastSaved, setLastSaved] = useState<Record<string, RowDraft>>({});
  // Raw MM/DD/YYYY-in-progress display text per date field, from
  // DateTextInput's onRawTextChange — needed for the autosave decision
  // (decideDateAutosave), since draft.expiration/beyondUseDate only ever
  // hold a complete ISO value or "", collapsing "still typing" and
  // "8 digits but not a real date" into the same value.
  const [rawDateText, setRawDateText] = useState<Record<string, { expiration: string; beyondUseDate: string }>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [beyondUseDateSupported, setBeyondUseDateSupported] = useState(true);
  const [budEnabledKeys, setBudEnabledKeys] = useState<Set<string>>(new Set());

  // V-T-ordering-lots-round4: no more explicit Save button, so more than
  // one row can be mid-autosave at once (e.g. tabbing quickly through
  // several rows) — keyed by productKey rather than a single "the one row
  // currently saving" string.
  const [savingByKey, setSavingByKey] = useState<Record<string, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [rowSaved, setRowSaved] = useState<Record<string, boolean>>({});

  const [activeBusyKey, setActiveBusyKey] = useState<string | null>(null);
  const [activeErrorByKey, setActiveErrorByKey] = useState<Record<string, string>>({});
  const [budBusyKey, setBudBusyKey] = useState<string | null>(null);
  const [budErrorByKey, setBudErrorByKey] = useState<Record<string, string>>({});

  // Review follow-up (reviewer, 2026-09-10): runAutosave used to read
  // `drafts`/`lastSaved`/`rawDateText`/`budEnabledKeys` straight from
  // component state, closed over at whatever render happened to be
  // current when scheduleAutosave's setTimeout was ARMED — one render
  // behind the very keystroke that armed it, since that keystroke's own
  // setDrafts/setRawDateText hadn't committed yet. Only the LAST-armed
  // timer per row ever survives to fire, so this silently dropped the
  // final keystroke of any typing burst before a pause (e.g. "LOT2026A"
  // autosaved as "LOT2026"). These refs are kept in sync SYNCHRONOUSLY at
  // every state-mutation call site below (not via a useEffect, which
  // would still be timing-dependent) — runAutosave reads from `.current`
  // instead, so it always sees the value as of when it actually RUNS, not
  // as of when the timer that led to it was scheduled.
  const draftsRef = useRef<Record<string, RowDraft>>({});
  const lastSavedRef = useRef<Record<string, RowDraft>>({});
  const rawDateTextRef = useRef<Record<string, { expiration: string; beyondUseDate: string }>>({});
  const budEnabledKeysRef = useRef<Set<string>>(new Set());

  // Autosave bookkeeping (refs, not state — purely internal timing/
  // race-guard plumbing that should never itself trigger a re-render):
  //  - autosaveRunnersRef: one lib/lots-autosave.ts createDebouncedRunner
  //    per row (productKey), reused across keystrokes so scheduling a new
  //    debounce correctly cancels that SAME row's pending one.
  //  - autosaveSeqRef: a per-row counter bumped on every autosave attempt
  //    AND on Clear lot, so a response that lands after a newer attempt
  //    (or after the row's lot was cleared) is recognized as stale and
  //    ignored — "ignore stale responses, latest write wins."
  //  - autosaveInFlightRef: true while a row's request is in flight, so a
  //    debounce/blur that fires while one is already running re-arms the
  //    timer instead of firing a second, racing request for the same row.
  const autosaveRunnersRef = useRef<Record<string, DebouncedRunner>>({});
  const autosaveSeqRef = useRef<Record<string, number>>({});
  const autosaveInFlightRef = useRef<Record<string, boolean>>({});

  // Review follow-up (reviewer, 2026-09-10): with no cleanup, typing in a
  // Lot #/date field and then navigating away from /lots before the
  // ~600ms debounce elapsed left that row's pending timer armed — it
  // still fired after unmount, running a real fetch and then calling
  // setState (setSavingByKey/setRowErrors/etc., inside runAutosave) on an
  // unmounted component. Cancel every row's pending timer on unmount.
  useEffect(() => {
    return () => {
      for (const runner of Object.values(autosaveRunnersRef.current)) runner.cancel();
    };
  }, []);

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setDrafts({});
    draftsRef.current = {};
    setLastSaved({});
    lastSavedRef.current = {};
    setRawDateText({});
    rawDateTextRef.current = {};
    setLoadError(null);
    setActiveErrorByKey({});
    setBudErrorByKey({});
    setBudEnabledKeys(new Set());
    budEnabledKeysRef.current = new Set();
    setSavingByKey({});
    setRowErrors({});
    setRowSaved({});
    for (const runner of Object.values(autosaveRunnersRef.current)) runner.cancel();
    autosaveRunnersRef.current = {};
    autosaveSeqRef.current = {};
    autosaveInFlightRef.current = {};
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

  /** Groups product views into COVID/Flu/Other ACTIVE sections (same
   * order lib/ordering-group.ts's Ordering-tab display already uses),
   * plus ONE flat, alphabetized list of every INACTIVE product regardless
   * of group — V-T-ordering-lots-round4, Will: "Filter inactives to the
   * bottom of the page" (replacing the previous round's per-group
   * inactive placement). See lib/lots-grouping.ts's
   * partitionProductsForLotsPage for the actual (unit-tested) logic. */
  const { sections: groupedActiveProducts, inactive: inactiveProducts } = useMemo(
    () => partitionProductsForLotsPage(productViews, ORDERING_GROUP_DISPLAY_ORDER),
    [productViews]
  );

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
      const loadedDrafts = draftsFromProducts(loadedViews, loadedLots);

      const loadedRawDateText = Object.fromEntries(
        Object.entries(loadedDrafts).map(([key, draft]) => [
          key,
          { expiration: isoToMaskedDate(draft.expiration), beyondUseDate: isoToMaskedDate(draft.beyondUseDate) },
        ])
      );

      setVaccines(loadedVaccines);
      setLots(loadedLots);
      setDrafts(loadedDrafts);
      draftsRef.current = loadedDrafts;
      // The freshly-loaded drafts ARE the last-saved snapshot (nothing's
      // been typed yet) — autosave compares future edits against this.
      setLastSaved(loadedDrafts);
      lastSavedRef.current = loadedDrafts;
      setRawDateText(loadedRawDateText);
      rawDateTextRef.current = loadedRawDateText;
      setBeyondUseDateSupported(lotsData.beyondUseDateSupported !== false);

      // BUD enablement is a secondary setting — a failure here doesn't
      // block the page from showing lots/vaccines, it just falls back to
      // "nothing enabled" (no BUD field editable) until the next reload.
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        const loadedBudKeys = new Set<string>(settingsData.budEnabledProductKeys ?? []);
        setBudEnabledKeys(loadedBudKeys);
        budEnabledKeysRef.current = loadedBudKeys;
      } else {
        setBudEnabledKeys(new Set());
        budEnabledKeysRef.current = new Set();
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
    setDrafts((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      draftsRef.current = next; // see draftsRef's own doc comment above
      return next;
    });
    setRowSaved((prev) => ({ ...prev, [key]: false }));
  }

  /** Mirrors DateTextInput's onRawTextChange into both state (so a
   * re-render, if any, reflects it) and rawDateTextRef (so runAutosave
   * reads it fresh regardless of which render's debounce timer fires) —
   * see rawDateTextRef's own doc comment above. */
  function updateRawDateText(key: string, patch: Partial<{ expiration: string; beyondUseDate: string }>) {
    setRawDateText((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      rawDateTextRef.current = next;
      return next;
    });
  }

  /** Lazily creates (and thereafter reuses) this row's debounce timer —
   * MUST be the same object across calls so a later schedule() correctly
   * cancels that row's earlier pending one (see
   * lib/lots-autosave.ts's createDebouncedRunner). `run` reads
   * everything it needs from the *Ref refs above at CALL time, so which
   * render happened to create this runner doesn't matter — only draftsRef
   * etc.'s value at the moment the timer actually fires does. */
  function getAutosaveRunner(view: ProductView): DebouncedRunner {
    const key = view.productKey;
    let runner = autosaveRunnersRef.current[key];
    if (!runner) {
      runner = createDebouncedRunner(() => void runAutosave(view), AUTOSAVE_DEBOUNCE_MS);
      autosaveRunnersRef.current[key] = runner;
    }
    return runner;
  }

  /** Resets/restarts a row's ~600ms-after-last-keystroke autosave timer —
   * called from every field's onChange, so typing in ANY of the row's
   * fields (lot #, expiration, beyond-use date) pushes the same shared
   * per-row debounce back out, and runAutosave (below) re-evaluates every
   * field once it settles. */
  function scheduleAutosave(view: ProductView) {
    getAutosaveRunner(view).schedule();
  }

  /** Flushes a row's pending debounced save immediately — wired to each
   * field's onBlur (Will's brief: "debounce ~600ms after the last
   * keystroke, also flush on blur"). */
  function flushAutosaveNow(view: ProductView) {
    getAutosaveRunner(view).flushNow();
  }

  /**
   * Autosave orchestrator for one product row (V-T-ordering-lots-round4,
   * Will: "make it autosave anytime new typing occurs, with date
   * validation happening on the date fields prior to saving"). Runs
   * lib/lots-autosave.ts's pure decide* functions against the row's
   * current draft vs. its last-persisted snapshot to decide whether
   * there's an eligible, changed field to send — a lot number that's
   * non-empty and different, or a date field that's a complete, valid
   * calendar date and different. `draft.lotNumber`/`draft.expiration`
   * must BOTH currently hold a usable value for the request to actually
   * fire (an incomplete/invalid date collapses draft.expiration to "" via
   * DateTextInput's own onChange contract, the same gate the old explicit
   * Save button relied on) — otherwise this is a silent no-op, not an
   * error, since the user may simply still be typing the other field.
   *
   * Reads `draft`/`saved`/raw date text/BUD-enablement from the *Ref
   * refs above, NOT from `drafts`/`lastSaved`/`rawDateText`/
   * `budEnabledKeys` state directly — this function is called from a
   * debounce timer that may fire long after the render that scheduled
   * it, and reading component state here would close over a stale
   * snapshot from THAT render (review follow-up, reviewer 2026-09-10 —
   * see draftsRef's doc comment above and lib/lots-autosave.ts's
   * createDebouncedRunner doc comment for the bug this fixes).
   *
   * Reuses the SAME POST (no lot yet) / PATCH (upsert against
   * matchLotNumber) fan-out calls the old Save button used. At most one
   * request is in flight per row at a time (autosaveInFlightRef) — a
   * debounce/blur firing while one is already running just re-arms the
   * timer instead of racing a second request for the same row — and a
   * per-row sequence number (autosaveSeqRef) makes a genuinely stale
   * response (e.g. the row's lot was cleared while this request was in
   * flight) a no-op instead of clobbering newer state: "ignore stale
   * responses, latest write wins."
   */
  async function runAutosave(view: ProductView) {
    if (!session) return;
    const key = view.productKey;

    if (autosaveInFlightRef.current[key]) {
      scheduleAutosave(view);
      return;
    }

    const draft = draftsRef.current[key];
    const saved = lastSavedRef.current[key];
    if (!draft || !saved) return;

    const rawText = rawDateTextRef.current[key] ?? {
      expiration: isoToMaskedDate(saved.expiration),
      beyondUseDate: isoToMaskedDate(saved.beyondUseDate),
    };

    const lotDecision = decideLotNumberAutosave(draft.lotNumber, saved.lotNumber);
    const expirationDecision = decideDateAutosave(rawText.expiration, isoToMaskedDate(saved.expiration));
    const budEnabledForThisProduct = budEnabledKeysRef.current.has(key);
    const beyondUseDecision = budEnabledForThisProduct
      ? decideDateAutosave(rawText.beyondUseDate, isoToMaskedDate(saved.beyondUseDate))
      : "unchanged";

    const hasEligibleChange = lotDecision === "save" || expirationDecision === "save" || beyondUseDecision === "save";
    const hasRequiredFields = draft.lotNumber.trim().length > 0 && draft.expiration !== "";
    if (!hasEligibleChange || !hasRequiredFields) return;

    const seq = (autosaveSeqRef.current[key] ?? 0) + 1;
    autosaveSeqRef.current[key] = seq;
    autosaveInFlightRef.current[key] = true;

    setSavingByKey((prev) => ({ ...prev, [key]: true }));
    setRowErrors((prev) => ({ ...prev, [key]: "" }));
    setRowSaved((prev) => ({ ...prev, [key]: false }));
    try {
      const lotNumber = draft.lotNumber.trim();
      const response = await fetch("/api/lots", {
        method: saved.matchLotNumber ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(
          saved.matchLotNumber
            ? {
                vaccineIds: view.vaccineIds,
                matchLotNumber: saved.matchLotNumber,
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

      if (autosaveSeqRef.current[key] !== seq) return; // superseded — ignore this stale response

      if (!response.ok) {
        setRowErrors((prev) => ({ ...prev, [key]: data.error ?? "Failed to save lot." }));
        return;
      }

      if (data.beyondUseDateSupported === false) setBeyondUseDateSupported(false);

      const savedLots: LotRow[] = data.lots ?? [];
      const groupVaccineIds = new Set(view.vaccineIds);
      const oldLotNumber = saved.matchLotNumber;
      setLots((prev) => {
        const withoutOld = oldLotNumber
          ? prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === oldLotNumber))
          : prev;
        return [...withoutOld, ...savedLots];
      });

      const nextSaved: RowDraft = {
        matchLotNumber: lotNumber,
        lotNumber,
        expiration: draft.expiration,
        beyondUseDate: draft.beyondUseDate,
      };
      setLastSaved((prev) => {
        const next = { ...prev, [key]: nextSaved };
        lastSavedRef.current = next;
        return next;
      });
      // Only update matchLotNumber on the live draft — never overwrite
      // lotNumber/expiration/beyondUseDate here, in case the user kept
      // typing further changes while this request was in flight.
      setDrafts((prev) => {
        const next = { ...prev, [key]: { ...prev[key], matchLotNumber: lotNumber } };
        draftsRef.current = next;
        return next;
      });
      setRowSaved((prev) => ({ ...prev, [key]: true }));
    } catch (err) {
      if (autosaveSeqRef.current[key] !== seq) return;
      setRowErrors((prev) => ({ ...prev, [key]: err instanceof Error ? err.message : "Failed to save lot." }));
    } finally {
      autosaveInFlightRef.current[key] = false;
      if (autosaveSeqRef.current[key] === seq) {
        setSavingByKey((prev) => ({ ...prev, [key]: false }));
      }
    }
  }

  /** Clears a product row's current lot across every dose vaccine_id at
   * once (DELETE /api/lots, vaccineIds + lot_number) — the ⚙ menu's
   * "Clear lot" action (renamed from "Delete lot", V-T-ordering-lots-
   * round4 — label only, behavior unchanged). Only ever called when
   * draft.matchLotNumber is set (button is disabled otherwise) — nothing
   * to clear for a product with no lot yet. */
  async function handleDeleteRow(view: ProductView) {
    if (!session) return;
    const draft = drafts[view.productKey];
    if (!draft?.matchLotNumber) return;

    // Cancel any pending autosave for this row and bump its sequence
    // number so an autosave response already in flight can't re-create
    // the lot this Clear is about to remove.
    autosaveRunnersRef.current[view.productKey]?.cancel();
    autosaveSeqRef.current[view.productKey] = (autosaveSeqRef.current[view.productKey] ?? 0) + 1;

    setSavingByKey((prev) => ({ ...prev, [view.productKey]: true }));
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
        setRowErrors((prev) => ({ ...prev, [view.productKey]: data.error ?? "Failed to clear lot." }));
        return;
      }

      const groupVaccineIds = new Set(view.vaccineIds);
      const deletedLotNumber = draft.matchLotNumber;
      setLots((prev) => prev.filter((l) => !(groupVaccineIds.has(l.vaccine_id) && l.lot_number === deletedLotNumber)));
      const cleared: RowDraft = { matchLotNumber: null, lotNumber: "", expiration: "", beyondUseDate: "" };
      setDrafts((prev) => {
        const next = { ...prev, [view.productKey]: cleared };
        draftsRef.current = next;
        return next;
      });
      setLastSaved((prev) => {
        const next = { ...prev, [view.productKey]: cleared };
        lastSavedRef.current = next;
        return next;
      });
      setRawDateText((prev) => {
        const next = { ...prev, [view.productKey]: { expiration: "", beyondUseDate: "" } };
        rawDateTextRef.current = next;
        return next;
      });
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [view.productKey]: err instanceof Error ? err.message : "Failed to clear lot." }));
    } finally {
      setSavingByKey((prev) => ({ ...prev, [view.productKey]: false }));
    }
  }

  /** PATCH /api/vaccines/{id} {active} on EVERY dose vaccine_id in the
   * product — looped client-side (same per-vaccine endpoint the desktop
   * Active-vaccines tab already uses). Optimistic local update with
   * revert-on-failure, matching runAutosave's own busy/error pattern. */
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
      const confirmedKeys = new Set<string>(data.budEnabledProductKeys ?? nextKeys);
      setBudEnabledKeys(confirmedKeys);
      budEnabledKeysRef.current = confirmedKeys;
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
    const saving = !!savingByKey[view.productKey];
    const activeError = activeErrorByKey[view.productKey];
    const activeBusy = activeBusyKey === view.productKey;
    const budError = budErrorByKey[view.productKey];
    const budBusy = budBusyKey === view.productKey;
    const budEnabledForThisProduct = budEnabledKeys.has(view.productKey);

    // Inactive wins over due (review follow-up: an inactive product's
    // expired lot must never mask the grey inactive style with the red
    // due one) — lib/lots-table.ts's resolveLotRowHighlight.
    const highlight = resolveLotRowHighlight(view.active, due);
    const rowStyle = highlight === "inactive" ? styles.inactiveRow : highlight === "due" ? styles.dueRow : undefined;

    return (
      <tr key={view.productKey} style={rowStyle}>
        <td style={styles.td}>{view.displayName}</td>
        <td style={styles.td}>{formatNdcDashed(view.ndc) || "—"}</td>
        <td style={styles.tdRight}>{view.packageSize ?? "—"}</td>
        <td style={styles.td}>
          <input
            style={styles.input}
            type="text"
            aria-label={`${view.displayName} lot number`}
            value={draft.lotNumber}
            onChange={(e) => {
              updateDraft(view.productKey, { lotNumber: e.target.value });
              scheduleAutosave(view);
            }}
            onBlur={() => flushAutosaveNow(view)}
          />
        </td>
        <td style={styles.td}>
          <DateTextInput
            value={draft.expiration}
            ariaLabel={`${view.displayName} expiration`}
            onChange={(value) => {
              updateDraft(view.productKey, { expiration: value });
              scheduleAutosave(view);
            }}
            onRawTextChange={(text) => updateRawDateText(view.productKey, { expiration: text })}
            onBlur={() => flushAutosaveNow(view)}
            style={styles.input}
          />
        </td>
        {beyondUseDateSupported && (
          <td style={styles.td}>
            {budEnabledForThisProduct ? (
              <DateTextInput
                value={draft.beyondUseDate}
                ariaLabel={`${view.displayName} beyond-use date`}
                onChange={(value) => {
                  updateDraft(view.productKey, { beyondUseDate: value });
                  scheduleAutosave(view);
                }}
                onRawTextChange={(text) => updateRawDateText(view.productKey, { beyondUseDate: text })}
                onBlur={() => flushAutosaveNow(view)}
                style={styles.input}
              />
            ) : (
              <span style={styles.muted}>—</span>
            )}
          </td>
        )}
        <td style={styles.td}>
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
                Clear lot
              </button>
              {activeError && <div style={styles.error}>{activeError}</div>}
              {budError && <div style={styles.error}>{budError}</div>}
            </div>
          </details>{" "}
          {saving && <span style={styles.muted}>Saving…</span>}
          {rowError && <div style={styles.error}>{rowError}</div>}
          {saved && !rowError && !saving && <div style={styles.success}>Saved.</div>}
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
            <th style={styles.thRight}>Units/pkg</th>
            <th style={styles.th}>Lot #</th>
            <th style={styles.th}>Expiration</th>
            {beyondUseDateSupported && <th style={styles.th}>Beyond-use date</th>}
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {groupedActiveProducts.map(({ group, products }) => (
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
              {products.map(renderProductRow)}
            </Fragment>
          ))}
          {/* V-T-ordering-lots-round4: ONE Inactive section for the whole
              page, after every active group — not one inactive sub-list
              per group like the previous round. */}
          {inactiveProducts.length > 0 && (
            <Fragment key="inactive">
              <tr style={styles.groupRow}>
                <td style={styles.td}>Inactive</td>
                <td style={styles.td}>—</td>
                <td style={styles.tdRight}>—</td>
                <td style={styles.td}>—</td>
                <td style={styles.td}>—</td>
                {beyondUseDateSupported && <td style={styles.td}>—</td>}
                <td style={styles.td}></td>
              </tr>
              {inactiveProducts.map(renderProductRow)}
            </Fragment>
          )}
        </tbody>
      </table>
    </main>
  );
}
