"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import {
  buildMacroCode,
  buildMacroRows,
  groupMacroRowsBySection,
  type MacroDoseButton,
  type MacroLotLike,
  type MacroProductGroup,
  type MacroRow,
  type MacroRowVaccine,
  type MacroSection,
  type MacroSectionGroup,
} from "@/lib/macro-codes";
import { formatNdcDisplay } from "@/lib/lots-grouping";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

/**
 * /macro-codes tab, round 4 (Will's brief, verbatim): "Remove the age
 * ranges and extraneous data from product names, as I've asked for
 * multiple times. Move age range and price to the end of the row. Have
 * a section (Flu, Pneumonia, RSV, etc) and then have the product
 * name/dose be inside a colored button 'Shingrix 1' 'Shingrix 2'
 * 'Abrysvo' 'Comirnaty 12+' 'mNEXSPIKE 12+', etc. Showing the product
 * name and dose number if there are multiple doses."
 *
 * One compact row per PRODUCT within each section: a colored button per
 * real dose row (label rules in lib/macro-codes.ts's doseButtonLabel),
 * then the product's age range and cash price at the row's end, then
 * one small ⚙ disclosure covering every dose of that product. Clicking
 * a dose button copies that dose's macro (or opens the lot/exp modal
 * when incomplete) — same copy-first-then-save modal logic as round 3,
 * unchanged. Names come pre-cleaned from lib/product-view.ts's
 * buildProductViews; pure row-building/grouping logic lives in
 * lib/macro-codes.ts / lib/macro-catalog.ts (both unit-tested).
 */

type VaccineRow = MacroRowVaccine;
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string; status: string };

type SectionColors = { bg: string; border: string; text: string };

/** One hue per section (Will's brief: "Colors: one hue per SECTION...
 * readable text, subtle (light background + darker border/text)").
 * Every MacroSection has an explicit entry so the palette is fully
 * deterministic — no runtime hashing/cycling logic to get wrong. */
const SECTION_COLORS: Readonly<Record<MacroSection, SectionColors>> = {
  Flu: { bg: "#e8f1fd", border: "#7fa8dd", text: "#1a4c8f" },
  COVID: { bg: "#f2ebfa", border: "#a67fd6", text: "#5a2d92" },
  Pneumonia: { bg: "#fdf1e3", border: "#e0a55e", text: "#8f5a17" },
  RSV: { bg: "#e5f7f4", border: "#5cc0b3", text: "#136a5e" },
  Shingles: { bg: "#fdecec", border: "#e07a7a", text: "#8f1f1f" },
  "Hep B": { bg: "#eaf7e8", border: "#7bc069", text: "#2d6b1e" },
  Tetanus: { bg: "#eceffb", border: "#8d97d4", text: "#32389b" },
  HPV: { bg: "#fbeaf3", border: "#d97fb0", text: "#96285f" },
  Meningitis: { bg: "#e7f6fb", border: "#63b6d5", text: "#155e78" },
  "Hep A": { bg: "#f3f0e6", border: "#b7a468", text: "#6b5a1c" },
  Typhoid: { bg: "#eef3f5", border: "#8ea6af", text: "#33505c" },
  MMR: { bg: "#f6ece6", border: "#c98f68", text: "#7a4419" },
  Other: { bg: "#f2f2f2", border: "#aaaaaa", text: "#4d4d4d" },
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1000 },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  sectionHeading: {
    fontSize: "0.95rem",
    fontWeight: 700,
    margin: "1rem 0 0.3rem",
    paddingBottom: "0.15rem",
    borderBottom: "1px solid #ccc",
  },
  productRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.6rem",
    padding: "3px 0",
    borderBottom: "1px solid #eee",
  },
  doseButtons: { display: "flex", flexWrap: "wrap" as const, gap: "0.3rem", alignItems: "center" },
  rowMeta: { display: "flex", alignItems: "center", gap: "0.6rem", whiteSpace: "nowrap" as const, flexShrink: 0 },
  ageText: { fontSize: "12px", color: "#555" },
  priceText: { fontSize: "12px", color: "#333", fontWeight: 600, minWidth: "4.5em", textAlign: "right" as const },
  copyFallback: { margin: "0.15rem 0 0.4rem", width: "100%" },
  copyFallbackInput: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.8rem",
    width: "100%",
    padding: "2px 4px",
    boxSizing: "border-box" as const,
    border: "1px solid #b00020",
  },
  // ⚙ settings menu — a native <details>/<summary> disclosure, same
  // pattern as round 3 (and /lots' row cog menus): a document
  // pointerdown listener (armed only while any menu is open) closes
  // every open .macro-settings-menu whose element doesn't contain the
  // click, plus Escape.
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
    minWidth: 220,
    fontSize: "12px",
  },
  menuDoseGroup: { padding: "2px 0", borderTop: "1px solid #eee", marginTop: "2px" },
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
  button: { padding: "0.3rem 0.6rem", fontSize: "13px" },
} as const;

/** "Copied ✓" is 8 characters — a button's reserved width is at least
 * that (plus a little breathing room) so swapping the label to the
 * copied flag never shifts layout, per Will's brief ("'Copied ✓'
 * feedback on the button for 1.5s without layout shift"). */
const COPIED_FLAG = "Copied ✓";
const MIN_BUTTON_CH = COPIED_FLAG.length + 1;

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

  const sections = useMemo(() => groupMacroRowsBySection(rows), [rows]);

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

  function renderDoseButton(dose: MacroDoseButton, colors: SectionColors) {
    const { row, label } = dose;
    const key = rowKey(row);
    const isNoShortCode = row.shortCode === null;
    const isCopied = copiedKey === key;
    const note = missingNote(row);

    return (
      <span key={key} style={{ position: "relative", display: "inline-block" }}>
        <button
          type="button"
          disabled={isNoShortCode}
          onClick={() => void handleCopy(row)}
          title={isNoShortCode ? "no short code set" : note ? note : `Copy ${label} macro code`}
          className="macro-dose-button"
          style={{
            border: `1px solid ${isNoShortCode ? "#ccc" : colors.border}`,
            background: isNoShortCode ? "#f2f2f2" : colors.bg,
            color: isNoShortCode ? "#888" : colors.text,
            borderRadius: 5,
            padding: "0.3rem 0.6rem",
            fontSize: "12.5px",
            fontWeight: 600,
            cursor: isNoShortCode ? "default" : "pointer",
            minWidth: `${Math.max(label.length, MIN_BUTTON_CH)}ch`,
            textAlign: "center",
          }}
        >
          {isCopied ? COPIED_FLAG : label}
        </button>
        {!isNoShortCode && note && (
          <span
            aria-hidden="true"
            title={note}
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#c62828",
              border: "1px solid #fff",
            }}
          />
        )}
        {copyFailure?.key === key && <CopyFallback code={copyFailure.code} />}
      </span>
    );
  }

  function renderSettingsMenu(product: MacroProductGroup) {
    const realDoses = product.doses.filter((d) => d.row.shortCode !== null);
    if (realDoses.length === 0) return null;
    const ndc = formatNdcDisplay(realDoses[0].row.ndc);

    return (
      <details className="macro-settings-menu" style={styles.menuDetails} onToggle={handleSettingsMenuToggle}>
        <summary style={styles.menuSummary} aria-label={`${product.displayName} details`}>
          ⚙
        </summary>
        <div style={styles.menuPanel}>
          <div style={styles.menuRow}>
            <span style={styles.menuLabel}>NDC</span>
            <span style={styles.menuValue}>{ndc}</span>
          </div>
          {realDoses.map((dose) => (
            <div key={rowKey(dose.row)} style={styles.menuDoseGroup}>
              <div style={styles.menuRow}>
                <span style={styles.menuLabel}>{realDoses.length > 1 ? `Dose ${dose.row.doseNumber} code` : "Short code"}</span>
                <span style={styles.menuValue}>{dose.row.shortCode}</span>
              </div>
              <div style={styles.menuRow}>
                <span style={styles.menuLabel}>{realDoses.length > 1 ? `Dose ${dose.row.doseNumber} macro` : "Macro text"}</span>
                <span style={styles.menuValue}>{dose.row.macro}</span>
              </div>
            </div>
          ))}
        </div>
      </details>
    );
  }

  function renderProductRow(product: MacroProductGroup, section: MacroSection) {
    const colors = SECTION_COLORS[section];
    const price = formatCashPrice(product.cashPriceCents);

    return (
      <div key={product.productKey} className="macro-row" style={styles.productRow}>
        <div style={styles.doseButtons}>{product.doses.map((dose) => renderDoseButton(dose, colors))}</div>
        <div className="macro-settings-cell" style={styles.rowMeta}>
          <span style={styles.ageText}>{product.age}</span>
          <span style={styles.priceText}>{price}</span>
          {renderSettingsMenu(product)}
        </div>
      </div>
    );
  }

  function renderSection(section: MacroSectionGroup) {
    return (
      <section key={section.section}>
        <h2 style={styles.sectionHeading}>{section.section}</h2>
        {section.products.map((product) => renderProductRow(product, section.section))}
      </section>
    );
  }

  return (
    <main style={styles.main}>
      <h1>Macro codes</h1>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}

      {!loading && sections.map((section) => renderSection(section))}

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
       * express (hover/focus states) — same "no external library"
       * posture as app/appointments/explorer/page.tsx's <style>
       * keyframes tag. The ⚙ column is opacity:0 by default and only
       * appears on row hover/focus-within, EXCEPT on touch devices (no
       * hover) where it's always visible, since a touch user can't
       * "hover" to reveal it. Dose buttons are real <button>s so
       * Enter/Space work natively with no extra keyboard handling. */}
      <style>{`
        .macro-dose-button:hover, .macro-dose-button:focus-visible {
          filter: brightness(0.96);
          outline: none;
        }
        .macro-dose-button:disabled { cursor: default; }
        .macro-settings-menu { opacity: 0; }
        .macro-row:hover .macro-settings-menu,
        .macro-row:focus-within .macro-settings-menu,
        .macro-settings-menu[open] {
          opacity: 1;
        }
        @media (hover: none) {
          .macro-settings-menu { opacity: 1; }
        }
      `}</style>
    </main>
  );
}
