"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildEntryValueRows, type EntryValueRow, type EntryValueVaccine } from "@/lib/entry-values";
import { planFillBlanksDirections } from "@/lib/entry-defaults";
import { createDebouncedRunner, type DebouncedRunner } from "@/lib/lots-autosave";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import ErrorToast, { useErrorToasts } from "@/app/error-toast";

/**
 * /entry-values tab (V-entry-values, Will's brief verbatim): "it seems
 * that you're missing the info needed to do everything (quantity,
 * instructions, etc), so ... I likely need to have an editor in the
 * cloud app where I can specify all those items and then you can use
 * that for data entry instead of me having to type it in while data
 * entry is happening." One compact table — same look/order as
 * /macro-codes' "All vaccines" section (lib/entry-values.ts's
 * buildEntryValueRows reuses lib/product-view.ts's buildProductViews
 * and lib/macro-catalog.ts, exactly like that page) — with editable
 * Quantity/Directions inputs instead of a copy button. Plain rows, no
 * per-product coloring (Will, round 2: colors "are hindering not
 * helping") — a thin top border marks where the Type column's value
 * changes from the row above, instead.
 *
 * Autosave (~500ms after the last keystroke, also flushed on blur) via
 * PATCH /api/vaccines/[id], reusing lib/lots-autosave.ts's
 * createDebouncedRunner (the same one /lots uses) — silent on success,
 * a red toast (app/error-toast.tsx) on failure. "Fill blanks with
 * defaults" applies lib/entry-defaults.ts's defaultDirections to every
 * row whose directions are currently blank, one PATCH per row, and
 * never touches a row that already has something on file.
 */

type RowDraft = { quantity: string; directions: string };

const AUTOSAVE_DEBOUNCE_MS = 500;

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  muted: { color: "#555", fontSize: "0.875rem" },
  error: { color: "#b00020", fontSize: "0.85rem" },
  pendingNote: { color: "#8a5300", fontSize: "0.8rem", fontStyle: "italic" as const },
  toolbar: { display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.5rem 0 1rem" },
  button: { padding: "0.4rem 0.75rem", fontSize: "13px" },
  fillMessage: { color: "#1a7a34", fontSize: "0.85rem" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "12.5px", lineHeight: 1.2 },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", verticalAlign: "middle" as const },
  type: { fontWeight: 600 },
  quantityInput: { width: "8ch", padding: "2px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb" },
  directionsInput: { width: "100%", minWidth: "22ch", padding: "2px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb" },
  /** Marks a new Type group — the first row of the table never gets it
   * (no border floating above the header). */
  typeGroupStart: { borderTop: "2px solid #ddd" },
  dot: {
    display: "inline-block",
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    verticalAlign: "middle" as const,
  },
} as const;

const BLANK_QUANTITY_HIGHLIGHT = "#fff6cc";

function isBlank(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0;
}

export default function EntryValuesPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<EntryValueVaccine[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantityDirectionsSupported, setQuantityDirectionsSupported] = useState(true);

  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [fillingBlanks, setFillingBlanks] = useState(false);
  const [fillMessage, setFillMessage] = useState<string | null>(null);

  const { toasts, pushError, dismiss } = useErrorToasts();

  // Same "read from a ref at fire-time, not at schedule-time" contract
  // /lots uses (lib/lots-autosave.ts's createDebouncedRunner doc
  // comment) — draftsRef/lastSavedRef are kept in sync SYNCHRONOUSLY at
  // every state-mutation call site below.
  const draftsRef = useRef<Record<string, RowDraft>>({});
  const lastSavedRef = useRef<Record<string, RowDraft>>({});
  const autosaveRunnersRef = useRef<Record<string, DebouncedRunner>>({});
  const autosaveSeqRef = useRef<Record<string, number>>({});
  const autosaveInFlightRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    return () => {
      for (const runner of Object.values(autosaveRunnersRef.current)) runner.cancel();
    };
  }, []);

  function resetAfterSignOut() {
    setVaccines([]);
    setDrafts({});
    draftsRef.current = {};
    lastSavedRef.current = {};
    setLoadError(null);
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

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/vaccines", { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) {
        setLoadError(data.error ?? "Could not load vaccines.");
        return;
      }

      const loadedVaccines: EntryValueVaccine[] = data.vaccines ?? [];
      setQuantityDirectionsSupported(data.quantityDirectionsSupported !== false);
      setVaccines(loadedVaccines);

      const loadedRows = buildEntryValueRows(loadedVaccines);
      const loadedDrafts: Record<string, RowDraft> = {};
      for (const row of loadedRows) {
        loadedDrafts[row.id] = { quantity: row.quantity ?? "", directions: row.directions ?? "" };
      }
      setDrafts(loadedDrafts);
      draftsRef.current = loadedDrafts;
      // The freshly-loaded drafts ARE the last-saved snapshot — autosave
      // compares future edits against this.
      lastSavedRef.current = loadedDrafts;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load vaccines.");
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
      const { data, error } = await supabase.auth.signInWithPassword({ email: signInEmail, password: signInPassword });
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

  const rows = useMemo(() => buildEntryValueRows(vaccines), [vaccines]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  function updateDraft(id: string, patch: Partial<RowDraft>) {
    setDrafts((prev) => {
      const next = { ...prev, [id]: { ...(prev[id] ?? { quantity: "", directions: "" }), ...patch } };
      draftsRef.current = next;
      return next;
    });
  }

  function getAutosaveRunner(id: string): DebouncedRunner {
    let runner = autosaveRunnersRef.current[id];
    if (!runner) {
      runner = createDebouncedRunner(() => void runAutosave(id), AUTOSAVE_DEBOUNCE_MS);
      autosaveRunnersRef.current[id] = runner;
    }
    return runner;
  }

  function scheduleAutosave(id: string) {
    getAutosaveRunner(id).schedule();
  }

  function flushAutosaveNow(id: string) {
    getAutosaveRunner(id).flushNow();
  }

  /** Sends a PATCH for whichever of quantity/directions changed since
   * the last-saved snapshot — silent on success, a red toast on failure
   * (Will's brief: "silent on success, red popup on failure"). Reads
   * from draftsRef/lastSavedRef at CALL time, not from component state,
   * so it always sees the value as of when it actually fires. */
  async function runAutosave(id: string) {
    if (!session) return;

    if (autosaveInFlightRef.current[id]) {
      scheduleAutosave(id);
      return;
    }

    const draft = draftsRef.current[id];
    const saved = lastSavedRef.current[id];
    if (!draft || !saved) return;

    const quantityChanged = draft.quantity !== saved.quantity;
    const directionsChanged = draft.directions !== saved.directions;
    if (!quantityChanged && !directionsChanged) return;

    const body: Record<string, string | null> = {};
    if (quantityChanged) body.quantity = draft.quantity.trim() === "" ? null : draft.quantity;
    if (directionsChanged) body.directions = draft.directions.trim() === "" ? null : draft.directions;

    const seq = (autosaveSeqRef.current[id] ?? 0) + 1;
    autosaveSeqRef.current[id] = seq;
    autosaveInFlightRef.current[id] = true;

    const row = rowById.get(id);
    const label = row ? `${row.displayName} dose ${row.doseNumber}` : "this row";

    try {
      const response = await fetch(`/api/vaccines/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));

      if (autosaveSeqRef.current[id] !== seq) return; // superseded — ignore this stale response

      if (!response.ok) {
        pushError(`Couldn't save entry values for ${label} — ${data.error ?? "Failed to save vaccine."}`);
        return;
      }

      if (data.quantityDirectionsSupported === false) setQuantityDirectionsSupported(false);

      setLastSavedRefAndState(id, draft);
    } catch (err) {
      if (autosaveSeqRef.current[id] !== seq) return;
      pushError(`Couldn't save entry values for ${label} — ${err instanceof Error ? err.message : "Failed to save vaccine."}`);
    } finally {
      autosaveInFlightRef.current[id] = false;
    }
  }

  function setLastSavedRefAndState(id: string, saved: RowDraft) {
    lastSavedRef.current = { ...lastSavedRef.current, [id]: saved };
  }

  /** "Fill blanks with defaults" (top-of-table button) — plans every
   * blank-directions row via lib/entry-defaults.ts's pure
   * planFillBlanksDirections, then PATCHes each one and updates local
   * state so the inputs reflect it immediately. Never touches a row
   * that already has non-blank directions. */
  async function handleFillBlanks() {
    if (!session) return;
    setFillMessage(null);

    const plannerRows = rows.map((row) => ({
      id: row.id,
      directions: draftsRef.current[row.id]?.directions ?? row.directions,
      doseNumber: row.doseNumber,
      doseCount: row.doseCount,
    }));
    const patches = planFillBlanksDirections(plannerRows);
    if (patches.length === 0) {
      setFillMessage("Nothing to fill — every row already has directions.");
      return;
    }

    setFillingBlanks(true);
    let succeeded = 0;
    try {
      for (const patch of patches) {
        // Cancel any pending per-row autosave first so it can't race
        // this PATCH with a stale draft.
        autosaveRunnersRef.current[patch.id]?.cancel();
        const seq = (autosaveSeqRef.current[patch.id] ?? 0) + 1;
        autosaveSeqRef.current[patch.id] = seq;

        try {
          const response = await fetch(`/api/vaccines/${patch.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
            body: JSON.stringify({ directions: patch.directions }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const row = rowById.get(patch.id);
            pushError(`Couldn't fill directions for ${row?.displayName ?? "a row"} — ${data.error ?? "Failed to save vaccine."}`);
            continue;
          }
          succeeded += 1;
          updateDraft(patch.id, { directions: patch.directions });
          const prevSaved = lastSavedRef.current[patch.id] ?? { quantity: "", directions: "" };
          setLastSavedRefAndState(patch.id, { ...prevSaved, directions: patch.directions });
        } catch (err) {
          const row = rowById.get(patch.id);
          pushError(`Couldn't fill directions for ${row?.displayName ?? "a row"} — ${err instanceof Error ? err.message : "Failed to save vaccine."}`);
        }
      }
    } finally {
      setFillingBlanks(false);
      if (succeeded > 0) setFillMessage(`Filled ${succeeded} direction${succeeded === 1 ? "" : "s"}.`);
    }
  }

  useEffect(() => {
    if (!fillMessage) return;
    const timer = setTimeout(() => setFillMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [fillMessage]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view entry values."
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

  function renderRow(row: EntryValueRow, isTypeGroupStart: boolean) {
    const draft = drafts[row.id] ?? { quantity: "", directions: "" };
    const quantityBlank = isBlank(draft.quantity);
    const complete = !quantityBlank && !isBlank(draft.directions);
    const groupBorder = isTypeGroupStart ? styles.typeGroupStart : undefined;

    return (
      <tr key={row.id}>
        <td style={{ ...styles.td, ...styles.type, ...groupBorder }}>{row.catalogType}</td>
        <td style={{ ...styles.td, ...groupBorder }}>{row.displayName}</td>
        <td style={{ ...styles.td, ...groupBorder }}>Dose {row.doseNumber}</td>
        <td style={{ ...styles.td, ...groupBorder, background: quantityBlank ? BLANK_QUANTITY_HIGHLIGHT : undefined }}>
          <input
            type="text"
            aria-label={`${row.displayName} dose ${row.doseNumber} quantity`}
            style={styles.quantityInput}
            value={draft.quantity}
            onChange={(e) => {
              updateDraft(row.id, { quantity: e.target.value });
              scheduleAutosave(row.id);
            }}
            onBlur={() => flushAutosaveNow(row.id)}
          />
        </td>
        <td style={{ ...styles.td, ...groupBorder }}>
          <input
            type="text"
            aria-label={`${row.displayName} dose ${row.doseNumber} directions`}
            style={styles.directionsInput}
            value={draft.directions}
            onChange={(e) => {
              updateDraft(row.id, { directions: e.target.value });
              scheduleAutosave(row.id);
            }}
            onBlur={() => flushAutosaveNow(row.id)}
          />
        </td>
        <td style={{ ...styles.td, ...groupBorder }}>
          <span
            style={{ ...styles.dot, background: complete ? "#16a34a" : "#c9c9c9" }}
            title={complete ? "Quantity and directions on file" : "Missing quantity or directions"}
            aria-label={complete ? "complete" : "incomplete"}
          />
        </td>
      </tr>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Entry values</h1>
      <p style={styles.muted}>
        Quantity and directions used for Pioneer prescription entry, per dose. Changes save automatically.
      </p>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}
      {!quantityDirectionsSupported && (
        <p style={styles.pendingNote}>Quantity/Directions aren&apos;t available yet on this environment (pending migration).</p>
      )}

      {!loading && rows.length > 0 && (
        <>
          <p style={styles.toolbar}>
            <button type="button" style={styles.button} onClick={() => void handleFillBlanks()} disabled={fillingBlanks}>
              {fillingBlanks ? "Filling…" : "Fill blanks with defaults"}
            </button>
            {fillMessage && <span style={styles.fillMessage}>{fillMessage}</span>}
          </p>

          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Product</th>
                <th style={styles.th}>Dose</th>
                <th style={styles.th}>Quantity</th>
                <th style={styles.th}>Directions</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => renderRow(row, index > 0 && rows[index - 1].catalogType !== row.catalogType))}
            </tbody>
          </table>
        </>
      )}

      <ErrorToast toasts={toasts} onDismiss={dismiss} />
    </main>
  );
}
