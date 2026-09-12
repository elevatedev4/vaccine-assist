"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import {
  buildMacroCode,
  buildMacroRows,
  groupMacroRowsForFamily,
  type MacroFamily,
  type MacroGroupedRow,
  type MacroLotLike,
  type MacroRow,
  type MacroRowVaccine,
} from "@/lib/macro-codes";
import { formatNdcDisplay } from "@/lib/lots-grouping";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

/**
 * /macro-codes tab, round 3 (Will's brief, verbatim highlights):
 * "Remove 'Dose ' from the dose data, it's redundant... For multi-dose
 * series, combine the heading instead of listing it multiple times.
 * Add a border around the sections to differentiate the vaccines from
 * one another... if it's the same product, no need to list it multiple
 * times. Remove the colors, they are hindering not helping. Remove
 * helper text... Make the 'All vaccines' section be 'Other vaccines'
 * and don't include flu/covid. Add mFLUSIVA and FluMist to the
 * flu/covid section... Arrange them by age. Add an age column... Make
 * it so if they click anywhere on the row it will copy and the
 * settings button should be outside that on the right side and just
 * show up on hover. Price should also not be repeated... include with
 * the product."
 *
 * Pure row-building + catalog/family/grouping logic lives in
 * lib/macro-codes.ts / lib/macro-catalog.ts (both unit-tested); this
 * page is just data loading + the compact, bordered-by-Type table
 * layout + the click-row-to-copy/modal UI.
 */

type VaccineRow = MacroRowVaccine;
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string; status: string };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  button: { padding: "0.3rem 0.6rem", fontSize: "13px", minWidth: 68 },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#b00020", fontSize: "0.7rem", fontStyle: "italic" as const, whiteSpace: "nowrap" as const },
  sectionHeading: { fontSize: "0.95rem", fontWeight: 700, margin: "1.25rem 0 0.35rem" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "12.5px", lineHeight: 1.15 },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "1px 6px", verticalAlign: "middle" as const },
  typeCell: { fontWeight: 600, verticalAlign: "top" as const, whiteSpace: "nowrap" as const },
  ageCell: { whiteSpace: "nowrap" as const, color: "#444" },
  productCell: { whiteSpace: "nowrap" as const },
  copyHint: { color: "#888", fontWeight: 400 as const },
  copiedFlag: { color: "#1a7f37", fontWeight: 600 },
  copyFallback: { marginTop: "0.25rem" },
  copyFallbackInput: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.8rem",
    width: "100%",
    padding: "2px 4px",
    boxSizing: "border-box" as const,
    border: "1px solid #b00020",
  },
  // ⚙ settings menu — a native <details>/<summary> disclosure. Native
  // <details> does NOT close itself on an outside click, so a document
  // pointerdown listener (armed only while any menu is open — same
  // pattern as /lots' row cog menus and app/top-nav.tsx's account menu)
  // closes every open .macro-settings-menu whose element doesn't
  // contain the click, plus Escape.
  menuDetails: { display: "inline-block", position: "relative" as const },
  menuSummary: { cursor: "pointer", listStyle: "none" as const, padding: "0 4px", border: "1px solid #ccc", borderRadius: 3, fontSize: "11px" },
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
    minWidth: 200,
    fontSize: "12px",
  },
  menuRow: { display: "flex", justifyContent: "space-between", gap: "0.75rem", padding: "1px 0" },
  menuLabel: { color: "#555" },
  menuValue: { fontFamily: "ui-monospace, monospace" },
  modalOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "1rem",
  },
  modalCard: {
    background: "#fff",
    borderRadius: 8,
    padding: "1.5rem",
    maxWidth: 420,
    width: "100%",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
  },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" as const, border: "1px solid #bbb" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem", fontSize: "0.85rem" },
  checkboxRow: { display: "flex", alignItems: "flex-start", gap: "0.4rem", marginBottom: "0.75rem", fontSize: "0.85rem" },
} as const;

const FAMILY_DEFS: readonly { key: MacroFamily; heading: string }[] = [
  { key: "fluCovid", heading: "Flu / COVID" },
  { key: "other", heading: "Other vaccines" },
];

/** Copies text via the Clipboard API, falling back to a hidden
 * textarea + execCommand for non-secure (http, non-localhost) contexts
 * where navigator.clipboard is unavailable. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand fallback below
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Read-only, auto-selected text field shown when copyToClipboard
 * returns false — the code is still visible/selectable so a manual
 * Cmd/Ctrl+C still works even though the programmatic copy didn't. */
function CopyFallback({ code }: { code: string }) {
  return (
    <p style={styles.copyFallback}>
      <span style={styles.error}>Couldn&apos;t copy — select and copy manually:</span>
      <br />
      <input
        type="text"
        readOnly
        autoFocus
        value={code}
        style={styles.copyFallbackInput}
        onFocus={(e) => e.currentTarget.select()}
      />
    </p>
  );
}

function missingNote(row: MacroRow): string | null {
  if (row.complete || row.shortCode === null) return null;
  const missingLot = !row.lotNumber;
  const missingExp = !row.expirationIso;
  if (missingLot && missingExp) return "lot + exp missing";
  if (missingLot) return "lot missing";
  if (missingExp) return "exp missing";
  return null;
}

function formatCashPrice(cents: number | null): string {
  if (cents === null) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

export default function MacroCodesPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<VaccineRow[]>([]);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<{ key: string; code: string } | null>(null);
  const [anyMenuOpen, setAnyMenuOpen] = useState(false);

  type ModalState = {
    row: MacroRow;
    lotNumber: string;
    expirationIso: string;
    saveToSystem: boolean;
    submitting: boolean;
    error: string | null;
    /** Set once the copy-first step below has run, so the UI can show
     * "already copied" / the manual-copy fallback independently of
     * whatever happens afterward with the save request. */
    copyResult: { copied: boolean; code: string } | null;
    /** True once POST /api/lots has already succeeded for this modal —
     * a failed copy leaves the modal open so the user can retry Submit
     * (to re-attempt the copy), and this stops that retry from firing a
     * second, duplicate lot save. */
    saved: boolean;
  };
  const [modal, setModal] = useState<ModalState | null>(null);

  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
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
      const headers = { Authorization: `Bearer ${token}` };
      const [vaccinesRes, lotsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers }),
        fetch("/api/lots", { headers }),
      ]);
      const [vaccinesData, lotsData] = await Promise.all([vaccinesRes.json(), lotsRes.json()]);

      if (!vaccinesRes.ok) {
        setLoadError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }
      if (!lotsRes.ok) {
        setLoadError(lotsData.error ?? "Could not load lots.");
        return;
      }

      setVaccines(vaccinesData.vaccines ?? []);
      setLots(lotsData.lots ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load macro codes.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refetchLots = useCallback(async (token: string) => {
    const response = await fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (response.ok) setLots(data.lots ?? []);
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

  const productViews = useMemo(() => buildProductViews(vaccines), [vaccines]);

  const activeLotsByVaccineId = useMemo(() => {
    const map: Record<string, MacroLotLike[]> = {};
    for (const lot of lots) {
      (map[lot.vaccine_id] ??= []).push({ status: lot.status, expiration: lot.expiration, lot_number: lot.lot_number });
    }
    return map;
  }, [lots]);

  const rows = useMemo(
    () => buildMacroRows(productViews, vaccines, activeLotsByVaccineId),
    [productViews, vaccines, activeLotsByVaccineId]
  );

  const groupedByFamily = useMemo(() => {
    const map: Record<MacroFamily, MacroGroupedRow[]> = { fluCovid: [], other: [] };
    for (const { key } of FAMILY_DEFS) {
      map[key] = groupMacroRowsForFamily(rows, key);
    }
    return map;
  }, [rows]);

  function rowKey(row: MacroRow): string {
    return `${row.productKey}:${row.doseNumber}`;
  }

  // Closes every open ⚙ menu on an outside click/tap, and on Escape —
  // same pattern as /lots' row cog menus.
  useEffect(() => {
    if (!anyMenuOpen) return;

    function closeMenusNotContaining(target: Node | null) {
      let stillOpen = false;
      document.querySelectorAll<HTMLDetailsElement>(".macro-settings-menu").forEach((el) => {
        if (!el.open) return;
        if (target && el.contains(target)) {
          stillOpen = true;
          return;
        }
        el.open = false;
      });
      setAnyMenuOpen(stillOpen);
    }

    function handlePointerDown(event: PointerEvent) {
      closeMenusNotContaining(event.target as Node);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenusNotContaining(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anyMenuOpen]);

  function handleSettingsMenuToggle() {
    const stillOpen = Array.from(document.querySelectorAll<HTMLDetailsElement>(".macro-settings-menu")).some(
      (el) => el.open
    );
    setAnyMenuOpen(stillOpen);
  }

  /** Closes the modal — used by Cancel, Escape, and an overlay click,
   * but not while a submit is in flight (matches Cancel's own disabled-
   * while-submitting behavior, so a save request can't be abandoned
   * mid-flight from underneath itself). */
  function requestCloseModal() {
    setModal((current) => (current && !current.submitting ? null : current));
  }

  async function handleCopy(row: MacroRow) {
    if (!row.macro || !row.shortCode) return;
    if (row.complete) {
      const key = rowKey(row);
      const ok = await copyToClipboard(row.macro);
      if (ok) {
        setCopyFailure(null);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
      } else {
        setCopiedKey(null);
        setCopyFailure({ key, code: row.macro });
      }
      return;
    }
    setCopyFailure(null);
    setModal({
      row,
      lotNumber: row.lotNumber ?? "",
      expirationIso: row.expirationIso ?? "",
      saveToSystem: row.packageSize !== 1,
      submitting: false,
      error: null,
      copyResult: null,
      saved: false,
    });
  }

  async function handleModalSubmit(event: FormEvent) {
    event.preventDefault();
    if (!modal || !session) return;
    const trimmedLot = modal.lotNumber.trim();
    if (!trimmedLot || !modal.expirationIso) return;

    const finalCode = modal.row.shortCode
      ? buildMacroCode({
          shortCode: modal.row.shortCode,
          doseNumber: modal.row.doseNumber,
          doseCount: 1,
          lotNumber: trimmedLot,
          expirationIso: modal.expirationIso,
        }).text
      : null;

    // Copy FIRST, before any await touches the network — Safari/iOS
    // revokes clipboard permission for a handler that has already
    // awaited a fetch, so on the default path (save checkbox checked)
    // copying AFTER the save+refetch silently failed there. The very
    // first await in this whole handler is this one.
    const copied = finalCode ? await copyToClipboard(finalCode) : false;

    setModal({ ...modal, submitting: true, error: null, copyResult: finalCode ? { copied, code: finalCode } : null });

    // Skip the save if a previous submit for this same modal already
    // saved it (see ModalState.saved's doc comment) — only a failed
    // copy leaves the modal open for a retry, and retrying should only
    // re-attempt the copy, not insert a second lot.
    if (modal.saveToSystem && !modal.saved) {
      try {
        const response = await fetch("/api/lots", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
          body: JSON.stringify({
            vaccine_ids: modal.row.vaccineIds,
            lot_number: trimmedLot,
            expiration: modal.expirationIso,
            status: "active",
          }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          // Save failed — keep the modal open with the error, but the
          // copy (or copy-fallback UI) above still reflects what
          // already happened to the clipboard.
          setModal((current) =>
            current ? { ...current, submitting: false, error: body.error ?? "Could not save the lot." } : current
          );
          return;
        }
        setModal((current) => (current ? { ...current, saved: true } : current));
        await refetchLots(session.accessToken);
      } catch (err) {
        setModal((current) =>
          current ? { ...current, submitting: false, error: err instanceof Error ? err.message : "Could not save the lot." } : current
        );
        return;
      }
    }

    if (copied) {
      setModal(null);
    } else {
      // Leave the modal open showing the manual-copy fallback rather
      // than closing on a copy that didn't actually happen.
      setModal((current) => (current ? { ...current, submitting: false } : current));
    }
  }

  // Escape closes the modal, same pattern as top-nav.tsx's account menu
  // (document-level keydown listener, only attached while open).
  useEffect(() => {
    if (!modal) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestCloseModal();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal !== null]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view macro codes."
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

  /** Row click/keyboard handler — clicking or pressing Enter/Space
   * anywhere on the row copies (or opens the modal for an incomplete
   * row), per Will's round-3 brief ("if they click anywhere on the row
   * it will copy"). The ⚙ settings cell stops propagation so it never
   * triggers this. */
  function handleRowActivate(row: MacroRow) {
    if (row.shortCode === null) return;
    void handleCopy(row);
  }

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>, row: MacroRow) {
    // A keydown that originated inside the ⚙ settings cell (e.g. Enter/
    // Space on the <summary> to toggle the native <details>) bubbles up
    // to this row handler — ignore it here so the row's preventDefault
    // doesn't kill the details toggle and so it doesn't also copy the
    // row. The settings cell's own onKeyDown below stops propagation
    // too, but this guard covers it regardless of ordering/future
    // changes to that cell's markup.
    if ((event.target as HTMLElement).closest(".macro-settings-cell")) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleRowActivate(row);
  }

  function renderRow(row: MacroGroupedRow, familyKey: string) {
    const key = `${familyKey}:${rowKey(row)}`;
    const note = missingNote(row);
    const isNoShortCode = row.shortCode === null;
    const copyKey = rowKey(row);
    const isCopied = copiedKey === copyKey;
    const price = formatCashPrice(row.cashPriceCents);
    const doseLabel = row.doseCount > 1 ? String(row.doseNumber) : "";

    return (
      <tr
        key={key}
        className={`macro-row${row.showType ? " macro-row--type-start" : ""}`}
        role={isNoShortCode ? undefined : "button"}
        tabIndex={isNoShortCode ? undefined : 0}
        aria-label={isNoShortCode ? undefined : `Copy ${row.displayName} dose ${row.doseNumber} macro code`}
        onClick={() => handleRowActivate(row)}
        onKeyDown={(e) => handleRowKeyDown(e, row)}
      >
        <td style={{ ...styles.td, ...styles.typeCell }}>{row.showType ? row.catalogType : ""}</td>
        <td style={{ ...styles.td, ...styles.ageCell }}>{row.showProduct ? row.age : ""}</td>
        <td style={{ ...styles.td, ...styles.productCell }}>
          {row.showProduct ? (price ? `${row.displayName} · ${price}` : row.displayName) : ""}
        </td>
        <td style={styles.td}>{doseLabel}</td>
        <td style={styles.td}>
          {isNoShortCode ? (
            <em style={styles.muted}>no short code set</em>
          ) : (
            <>
              {isCopied ? <span style={styles.copiedFlag}>Copied ✓</span> : <span style={styles.copyHint}>Copy</span>}
              {note && <span style={{ ...styles.note, marginLeft: "0.4rem" }}>{note}</span>}
              {copyFailure?.key === copyKey && <CopyFallback code={copyFailure.code} />}
            </>
          )}
        </td>
        <td
          className="macro-settings-cell"
          style={{ ...styles.td, textAlign: "right" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {!isNoShortCode && (
            <details className="macro-settings-menu" style={styles.menuDetails} onToggle={handleSettingsMenuToggle}>
              <summary style={styles.menuSummary} aria-label={`${row.displayName} dose ${row.doseNumber} details`}>
                ⚙
              </summary>
              <div style={styles.menuPanel}>
                <div style={styles.menuRow}>
                  <span style={styles.menuLabel}>Short code</span>
                  <span style={styles.menuValue}>{row.shortCode}</span>
                </div>
                <div style={styles.menuRow}>
                  <span style={styles.menuLabel}>Macro text</span>
                  <span style={styles.menuValue}>{row.macro}</span>
                </div>
                <div style={styles.menuRow}>
                  <span style={styles.menuLabel}>NDC</span>
                  <span style={styles.menuValue}>{formatNdcDisplay(row.ndc)}</span>
                </div>
              </div>
            </details>
          )}
        </td>
      </tr>
    );
  }

  function renderFamilyTable(familyRows: MacroGroupedRow[], familyKey: string) {
    if (familyRows.length === 0) return null;
    return (
      <table className="macro-table" style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Type</th>
            <th style={styles.th}>Age</th>
            <th style={styles.th}>Product</th>
            <th style={styles.th}>Dose</th>
            <th style={styles.th}></th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {familyRows.map((row) => (
            <Fragment key={`${familyKey}:${rowKey(row)}`}>{renderRow(row, familyKey)}</Fragment>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Macro codes</h1>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}

      {!loading &&
        FAMILY_DEFS.map(({ key, heading }) => {
          const familyRows = groupedByFamily[key];
          if (familyRows.length === 0) return null;
          return (
            <section key={key}>
              <h2 style={styles.sectionHeading}>{heading}</h2>
              {renderFamilyTable(familyRows, key)}
            </section>
          );
        })}

      {modal && (
        <div
          style={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            // Overlay click closes; a click that started inside the
            // card (bubbling up) has e.target !== the overlay itself,
            // so it's excluded here without needing stopPropagation.
            if (e.target === e.currentTarget) requestCloseModal();
          }}
        >
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>
              Enter lot / exp for {modal.row.displayName} dose {modal.row.doseNumber}
            </h2>
            {modal.copyResult && !modal.copyResult.copied && <CopyFallback code={modal.copyResult.code} />}
            <form onSubmit={handleModalSubmit}>
              <label style={styles.label} htmlFor="macro-modal-lot">
                Lot number
              </label>
              <input
                id="macro-modal-lot"
                style={styles.field}
                type="text"
                value={modal.lotNumber}
                onChange={(e) => setModal({ ...modal, lotNumber: e.target.value })}
                autoFocus
              />

              <label style={styles.label} htmlFor="macro-modal-exp">
                Expiration
              </label>
              <DateTextInput
                value={modal.expirationIso}
                onChange={(iso) => setModal((current) => (current ? { ...current, expirationIso: iso } : current))}
                ariaLabel="Expiration"
                style={styles.field}
              />

              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={modal.saveToSystem}
                  onChange={(e) => setModal({ ...modal, saveToSystem: e.target.checked })}
                />
                <span>
                  Save this lot/exp to the system
                  {modal.row.packageSize === 1 && (
                    <>
                      <br />
                      <span style={styles.muted}>Not recommended for single-dose packages (pkg size 1).</span>
                    </>
                  )}
                </span>
              </label>

              {modal.error && (
                <p style={styles.error}>
                  {modal.error}
                  {modal.copyResult?.copied && " (the code was already copied to your clipboard)"}
                </p>
              )}

              <p style={{ textAlign: "right", marginBottom: 0 }}>
                <button type="button" style={styles.button} onClick={requestCloseModal} disabled={modal.submitting}>
                  Cancel
                </button>{" "}
                <button
                  type="submit"
                  style={styles.button}
                  disabled={modal.submitting || !modal.lotNumber.trim() || !modal.expirationIso}
                >
                  {modal.submitting ? "Saving…" : "Submit"}
                </button>
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Row-level interaction styling that plain inline styles can't
       * express (hover/focus states, and the ⚙ column's border-around-
       * Type-block rule) — same "no external library" posture as
       * app/appointments/explorer/page.tsx's <style> keyframes tag.
       * The settings cell is opacity:0 by default and only appears on
       * row hover/focus-within, EXCEPT on touch devices (no hover) where
       * it's always visible, since a touch user can't "hover" to reveal
       * it. macro-row--type-start draws the top border of each bordered
       * Type block; the table's own bottom border plus this rule
       * produces one full border around every Type group. */}
      <style>{`
        .macro-table tbody tr.macro-row { cursor: pointer; }
        .macro-table tbody tr.macro-row:hover,
        .macro-table tbody tr.macro-row:focus-visible {
          background: #f2f6fb;
          outline: none;
        }
        .macro-table tbody tr.macro-row--type-start td {
          border-top: 1px solid #ccc;
        }
        .macro-table tbody tr.macro-row:last-child td {
          border-bottom: 1px solid #ccc;
        }
        .macro-settings-cell { opacity: 0; }
        .macro-row:hover .macro-settings-cell,
        .macro-row:focus-within .macro-settings-cell {
          opacity: 1;
        }
        @media (hover: none) {
          .macro-settings-cell { opacity: 1; }
        }
      `}</style>
    </main>
  );
}
