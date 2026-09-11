"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { buildProductViews } from "@/lib/product-view";
import { buildMacroCode, buildMacroRows, type MacroLotLike, type MacroRow, type MacroRowVaccine } from "@/lib/macro-codes";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import DateTextInput from "@/app/date-text-input";

/**
 * /macro-codes tab (Will's brief, verbatim): "add new tab 'Macro codes'
 * that follows the setup of the attached excel file and allows for
 * one-click copying of the macro code for each dose. If an item is
 * missing lot/exp, add a note at the end that shows the lot is missing.
 * when they try to copy it make a popup for them to enter the lot/exp,
 * then copy the code with the correct lot/exp. Include a checkbox
 * before submit that allows them to save the lot/exp in the system, but
 * not recommended if the item is pkg size 1. If pkg size is not 1,
 * automatically have the box checked for them."
 *
 * Pure row-building logic lives in lib/macro-codes.ts (unit-tested);
 * this page is just data loading + the copy/modal UI, styled
 * consistently with /lots (system font, compact spreadsheet table).
 * Saving a lot from the modal fans out to every dose vaccine_id of the
 * product (POST /api/lots vaccine_ids) — the SAME fan-out /lots already
 * uses, so a save here keeps the /lots page and desktop app in sync.
 */

type VaccineRow = MacroRowVaccine;
type LotRow = { id: string; vaccine_id: string; lot_number: string; expiration: string; status: string };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1000 },
  button: { padding: "0.3rem 0.7rem", fontSize: "13px" },
  error: { color: "#b00020", fontSize: "0.8rem" },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#b00020", fontSize: "0.78rem", fontStyle: "italic" as const, marginLeft: "0.5rem" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "13px", lineHeight: 1.2, marginTop: "0.75rem" },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #eee", verticalAlign: "top" as const },
  groupRow: { background: "#d9dde3", fontWeight: 600 },
  macroCode: { fontFamily: "ui-monospace, monospace", fontSize: "0.85rem" },
  dosesInput: { width: 40, padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "12px", marginLeft: "0.4rem" },
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

function missingNote(row: MacroRow): string | null {
  if (row.complete || row.shortCode === null) return null;
  const missingLot = !row.lotNumber;
  const missingExp = !row.expirationIso;
  if (missingLot && missingExp) return "lot + exp missing";
  if (missingLot) return "lot missing";
  if (missingExp) return "exp missing";
  return null;
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
  const [doseCounts, setDoseCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savingDoses, setSavingDoses] = useState<Record<string, boolean>>({});

  type ModalState = {
    row: MacroRow;
    lotNumber: string;
    expirationIso: string;
    saveToSystem: boolean;
    submitting: boolean;
    error: string | null;
  };
  const [modal, setModal] = useState<ModalState | null>(null);

  function resetAfterSignOut() {
    setVaccines([]);
    setLots([]);
    setDoseCounts({});
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
      const [vaccinesRes, lotsRes, settingsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers }),
        fetch("/api/lots", { headers }),
        fetch("/api/macro-codes/settings", { headers }),
      ]);
      const [vaccinesData, lotsData, settingsData] = await Promise.all([vaccinesRes.json(), lotsRes.json(), settingsRes.json()]);

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
      if (settingsRes.ok) setDoseCounts(settingsData.doseCounts ?? {});
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
    () => buildMacroRows(productViews, vaccines, activeLotsByVaccineId, doseCounts),
    [productViews, vaccines, activeLotsByVaccineId, doseCounts]
  );

  function rowKey(row: MacroRow): string {
    return `${row.productKey}:${row.doseNumber}`;
  }

  async function handleCopy(row: MacroRow) {
    if (!row.macro || !row.shortCode) return;
    if (row.complete) {
      const ok = await copyToClipboard(row.macro);
      if (ok) {
        setCopiedKey(rowKey(row));
        setTimeout(() => setCopiedKey((current) => (current === rowKey(row) ? null : current)), 1500);
      }
      return;
    }
    setModal({
      row,
      lotNumber: row.lotNumber ?? "",
      expirationIso: row.expirationIso ?? "",
      saveToSystem: row.packageSize !== 1,
      submitting: false,
      error: null,
    });
  }

  async function handleDosesChange(productKey: string, value: number) {
    if (!session) return;
    const next = { ...doseCounts, [productKey]: value };
    setDoseCounts(next);
    setSavingDoses((prev) => ({ ...prev, [productKey]: true }));
    try {
      const response = await fetch("/api/macro-codes/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ doseCounts: next }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setLoadError(body.error ?? "Could not save the dose count.");
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not save the dose count.");
    } finally {
      setSavingDoses((prev) => ({ ...prev, [productKey]: false }));
    }
  }

  async function handleModalSubmit(event: FormEvent) {
    event.preventDefault();
    if (!modal || !session) return;
    const trimmedLot = modal.lotNumber.trim();
    if (!trimmedLot || !modal.expirationIso) return;

    setModal({ ...modal, submitting: true, error: null });

    if (modal.saveToSystem) {
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
          setModal((current) => (current ? { ...current, submitting: false, error: body.error ?? "Could not save the lot." } : current));
          return;
        }
        await refetchLots(session.accessToken);
      } catch (err) {
        setModal((current) =>
          current ? { ...current, submitting: false, error: err instanceof Error ? err.message : "Could not save the lot." } : current
        );
        return;
      }
    }

    const finalCode = modal.row.shortCode
      ? buildMacroCode({
          shortCode: modal.row.shortCode,
          doseNumber: modal.row.doseNumber,
          doseCount: 1,
          lotNumber: trimmedLot,
          expirationIso: modal.expirationIso,
        }).text
      : null;
    if (finalCode) await copyToClipboard(finalCode);
    setModal(null);
  }

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

  let lastProductKey: string | null = null;
  let lastGroup: string | null = null;

  return (
    <main style={styles.main}>
      <h1>Macro codes</h1>
      <p style={styles.muted}>Click Copy to copy a dose&apos;s macro code. Rows missing a lot or expiration prompt for them first.</p>

      {loading && <p style={styles.muted}>Loading…</p>}
      {loadError && <p style={styles.error}>{loadError}</p>}

      {!loading && rows.length > 0 && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Vaccine</th>
              <th style={styles.th}>Dose</th>
              <th style={styles.th}>Short code</th>
              <th style={styles.th}>Macro</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = rowKey(row);
              const showGroupHeading = row.doseNumber === 1 && row.productKey !== lastProductKey;
              const showDosesInput = row.doseNumber === 1;
              const note = missingNote(row);
              const isNoShortCode = row.shortCode === null;

              // Group headings mirror /lots and /ordering: derived from
              // the product's group, injected once per group transition.
              const productGroup = productViews.find((p) => p.productKey === row.productKey)?.group ?? "Other";
              const groupHeadingRow =
                showGroupHeading && productGroup !== lastGroup ? (
                  <tr key={`group-${productGroup}-${row.productKey}`} style={styles.groupRow}>
                    <td style={styles.td} colSpan={5}>
                      {productGroup}
                    </td>
                  </tr>
                ) : null;
              if (showGroupHeading) lastGroup = productGroup;
              lastProductKey = row.productKey;

              return (
                <Fragment key={key}>
                  {groupHeadingRow}
                  <tr>
                    <td style={styles.td}>{row.displayName}</td>
                    <td style={styles.td}>
                      {row.doseNumber} of {row.doseCount}
                      {showDosesInput && (
                        <input
                          type="number"
                          min={1}
                          max={4}
                          value={row.doseCount}
                          disabled={savingDoses[row.productKey]}
                          onChange={(e) => {
                            const parsed = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 4) {
                              void handleDosesChange(row.productKey, parsed);
                            }
                          }}
                          style={styles.dosesInput}
                          aria-label={`Doses for ${row.displayName}`}
                          title="Doses in this series"
                        />
                      )}
                    </td>
                    <td style={styles.td}>{row.shortCode ?? "—"}</td>
                    <td style={styles.td}>
                      {isNoShortCode ? (
                        <em style={styles.muted}>no short code set</em>
                      ) : (
                        <>
                          <span style={styles.macroCode}>{row.macro}</span>
                          {note && <span style={styles.note}>{note}</span>}
                        </>
                      )}
                    </td>
                    <td style={styles.td}>
                      {!isNoShortCode && (
                        <button type="button" style={styles.button} onClick={() => void handleCopy(row)}>
                          {copiedKey === key ? "Copied" : "Copy"}
                        </button>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {modal && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>
              Enter lot / exp for {modal.row.displayName} dose {modal.row.doseNumber}
            </h2>
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

              {modal.error && <p style={styles.error}>{modal.error}</p>}

              <p style={{ textAlign: "right", marginBottom: 0 }}>
                <button type="button" style={styles.button} onClick={() => setModal(null)} disabled={modal.submitting}>
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
