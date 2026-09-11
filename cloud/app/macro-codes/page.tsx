"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import { buildMacroCode, buildMacroRows, type MacroLotLike, type MacroRow, type MacroRowVaccine } from "@/lib/macro-codes";
import { macroProductColor } from "@/lib/macro-colors";
import { formatNdcDisplay } from "@/lib/lots-grouping";
import type { MacroSection } from "@/lib/macro-catalog";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

/**
 * /macro-codes tab, round 2 (Will's brief, verbatim highlights): "Remove
 * the entry box for dose. It's always set already... Hide the short
 * code and macro code in a little settings dropdown at the far right...
 * follow the same format as the excel file... a section for covid/flu
 * vaccines for age 3-11 and then for 12+, then a section for all the
 * vaccines... type of vaccine, then the name of the product, then dose,
 * then the copy button, very succinct and compact. Include the cash
 * price too. Use color coding to differentiate the vaccines."
 *
 * Pure row-building + catalog/section/color logic lives in
 * lib/macro-codes.ts / lib/macro-catalog.ts / lib/macro-colors.ts
 * (all unit-tested); this page is just data loading + the compact
 * section layout + the copy/modal UI. Saving a lot from the modal fans
 * out to every dose vaccine_id of the product (POST /api/lots
 * vaccine_ids) — the SAME fan-out /lots already uses, so a save here
 * keeps the /lots page and desktop app in sync.
 */

type VaccineRow = MacroRowVaccine;
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string; status: string };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  button: { padding: "0.3rem 0.6rem", fontSize: "13px", minWidth: 68 },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#b00020", fontSize: "0.72rem", fontStyle: "italic" as const, marginLeft: "0.4rem", whiteSpace: "nowrap" as const },
  sectionHeading: { fontSize: "0.95rem", fontWeight: 700, margin: "1.25rem 0 0.35rem" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "12.5px", lineHeight: 1.2 },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", verticalAlign: "middle" as const },
  type: { fontWeight: 600 },
  cashPrice: { whiteSpace: "nowrap" as const },
  copyCell: { display: "flex", alignItems: "center", gap: "0.3rem" },
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

const SECTION_DEFS: readonly { key: MacroSection | "all"; heading: string }[] = [
  { key: "age3to11", heading: "COVID / Flu — Age 3-11" },
  { key: "age12plus", heading: "COVID / Flu — Age 12+" },
  { key: "altFlu", heading: "Alternative flu shots" },
  { key: "all", heading: "All vaccines" },
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

  function renderRow(row: MacroRow, sectionKey: string) {
    const key = `${sectionKey}:${rowKey(row)}`;
    const note = missingNote(row);
    const isNoShortCode = row.shortCode === null;
    const color = macroProductColor(row.productKey);
    const copyKey = rowKey(row);

    return (
      <tr key={key} style={{ background: color.background }}>
        <td style={{ ...styles.td, ...styles.type, color: color.text }}>{row.catalogType}</td>
        <td style={styles.td}>{row.displayName}</td>
        <td style={styles.td}>Dose {row.doseNumber}</td>
        <td style={{ ...styles.td, ...styles.cashPrice }}>{formatCashPrice(row.cashPriceCents)}</td>
        <td style={styles.td}>
          {isNoShortCode ? (
            <em style={styles.muted}>no short code set</em>
          ) : (
            <span style={styles.copyCell}>
              <button type="button" style={styles.button} onClick={() => void handleCopy(row)}>
                {copiedKey === copyKey ? "Copied" : "Copy"}
              </button>
              {note && <span style={styles.note}>{note}</span>}
              {copyFailure?.key === copyKey && <CopyFallback code={copyFailure.code} />}
            </span>
          )}
        </td>
        <td style={{ ...styles.td, textAlign: "right" }}>
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

  function renderSectionTable(sectionRows: MacroRow[], sectionKey: string) {
    if (sectionRows.length === 0) return null;
    return (
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Type</th>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.th}>Dose</th>
            <th style={styles.th}>Cash price</th>
            <th style={styles.th}></th>
            <th style={styles.th}></th>
          </tr>
        </thead>
        <tbody>
          {sectionRows.map((row) => (
            <Fragment key={`${sectionKey}:${rowKey(row)}`}>{renderRow(row, sectionKey)}</Fragment>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Macro codes</h1>
      <p style={styles.muted}>Click Copy to copy a dose&apos;s macro code. Rows missing a lot or expiration prompt for them first.</p>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}

      {!loading &&
        SECTION_DEFS.map(({ key, heading }) => {
          const sectionRows = key === "all" ? rows : rows.filter((row) => row.sections.includes(key));
          if (sectionRows.length === 0) return null;
          return (
            <section key={key}>
              <h2 style={styles.sectionHeading}>{heading}</h2>
              {renderSectionTable(sectionRows, key)}
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
    </main>
  );
}
