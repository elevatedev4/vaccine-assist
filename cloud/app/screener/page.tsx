"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import {
  CONDITION_ITEMS,
  DEFAULT_CONDITIONS,
  DIABETES_SUB_KEYS,
  type ConditionKey,
  type PriorPneumoHistory,
  type ScreenerConditions,
} from "@/lib/screener-rules";
import { groupScreenerResultsByType, screen, type ScreenerResult, type ScreenerTypeGroup } from "@/lib/screener";
import { matchScreenerProducts } from "@/lib/screener-macro";
import { buildProductViews } from "@/lib/product-view";
import {
  buildMacroCode,
  buildMacroRows,
  doseButtonShortLabel,
  macroSectionDisplayName,
  type MacroLotLike,
  type MacroProductGroup,
  type MacroRow,
  type MacroRowVaccine,
} from "@/lib/macro-codes";
import {
  SECTION_COLORS,
  copyToClipboard,
  macroRowKey,
  renderMacroDoseButton,
  type SectionColors,
} from "@/lib/macro-dose-button";
import DateTextInput from "@/app/date-text-input";
import type { FormEvent } from "react";

/**
 * Vaccine eligibility SCREENER (V-screener, Will 2026-09-13 verbatim:
 * "I want to add a page that helps the pharmacist screen for vaccine
 * eligibility using these health conditions ... select the health
 * conditions the patient did and then be shown a list of eligible
 * vaccines ... also have a box to enter patient age too, since many
 * vaccines are simply based on age.").
 *
 * Same client-page shell as app/doses-given/page.tsx (SignInGate +
 * subscribeToSessionState + AuthLoading) for the shared pharmacy login.
 * Eligibility itself is still every rule is code (lib/screener-rules.ts)
 * evaluated client-side by lib/screener.ts's pure `screen()`, so
 * eligibility updates live as the form changes with no network round
 * trip. Deliberately separate from the existing age-only eligibility
 * system (lib/eligibility.ts, app/api/eligibility/*) — see this page's
 * lib files for why.
 *
 * BY-TYPE REFORMAT (V-screener-by-type, coordinator brief 2026-09-13,
 * quoting Will verbatim: "I also asked for reformatting of this section
 * to be based on the vaccine type instead of product name, with the
 * products listed as our macro code buttons that can copy/paste").
 * Results are now grouped by vaccine TYPE (lib/screener.ts's
 * groupScreenerResultsByType — Pneumococcal/RSV/Shingles/etc., the same
 * MacroSection family vocabulary app/macro-codes/page.tsx uses) instead
 * of by eligibility status. Because rendering real, copy-to-clipboard
 * macro code buttons needs the SAME live vaccines+lots data the Macro
 * codes page uses, this page now ALSO fetches /api/vaccines and
 * /api/lots (previously it needed no network round trip at all — the
 * rule evaluation itself is still 100% client-side/no-I/O) and builds
 * MacroRows the same way app/macro-codes/page.tsx does. lib/screener-
 * macro.ts's matchScreenerProducts bridges a screener rule id to its
 * real MacroProductGroup(s); lib/macro-dose-button.tsx's
 * renderMacroDoseButton (extracted out of app/macro-codes/page.tsx, see
 * that file's own header) renders the exact same button — same colors,
 * same "Copied ✓" feedback, same "One dose"/"Dose 1"/"Dose 2 (2 mo)"
 * labels — so a pharmacist sees one consistent button style across both
 * pages. Only "not-indicated" results are hidden; every other status
 * (routine/risk/consider/caution/info) still shows, tinted with the same
 * statusGroupColor this page already used, now per PRODUCT ROW instead
 * of per status-group heading (a type can freely mix, e.g. RSV showing
 * Abrysvo as a risk-tinted row next to Arexvy as a caution-tinted row).
 * The eligibility/consider logic, the prior-pneumococcal dropdown, and
 * lib/screener-rules.ts's rules themselves are untouched — this is a
 * presentation-layer change only.
 */

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem", fontSize: "0.78rem" },
  heading: { margin: "0.5rem 0 0.25rem", fontSize: "1.25rem" },
  note: {
    margin: "0 0 1rem",
    padding: "0.5rem 0.75rem",
    background: "#eef6ff",
    border: "1px solid #cfe3fb",
    borderRadius: 6,
    color: "#1a4971",
    fontSize: "0.72rem",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  infoLink: { color: "#1a4971", whiteSpace: "nowrap" as const },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 360px) 1fr",
    gap: "1.5rem",
    alignItems: "start",
  },
  formCard: {
    border: "1px solid #d5dce3",
    borderRadius: 8,
    padding: "0.9rem 1rem",
    background: "#fff",
  },
  ageRow: { display: "flex", flexDirection: "column" as const, gap: "0.25rem", marginBottom: "0.9rem" },
  label: { fontWeight: 600, fontSize: "0.75rem", color: "#222" },
  ageInput: {
    padding: "0.35rem 0.5rem",
    fontSize: "0.95rem",
    border: "1px solid #ccc",
    borderRadius: 4,
    width: "8rem",
  },
  ageHint: { fontSize: "0.68rem", color: "#666" },
  conditionsLegend: { fontWeight: 700, fontSize: "0.75rem", margin: "0 0 0.4rem", color: "#222" },
  conditionRow: { display: "flex", alignItems: "flex-start", gap: "0.4rem", padding: "0.15rem 0" },
  conditionRowIndent: { marginLeft: "1.25rem" },
  groupHeading: { fontSize: "0.68rem", fontWeight: 700, color: "#555", margin: "0.5rem 0 0.1rem 1.25rem" },
  checkbox: { marginTop: "0.15rem" },
  conditionLabel: { fontSize: "0.75rem", lineHeight: 1.3 },
  priorPneumoRow: { marginTop: "0.9rem", paddingTop: "0.7rem", borderTop: "1px solid #eee" },
  radioRow: { display: "flex", gap: "1rem", marginTop: "0.3rem" },
  radioLabel: { display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem" },
  clearButton: {
    marginTop: "1rem",
    padding: "0.4rem 0.9rem",
    fontSize: "0.75rem",
    cursor: "pointer",
    border: "1px solid #999",
    borderRadius: 4,
    background: "#fff",
  },
  resultsWrap: { display: "flex", flexDirection: "column" as const, gap: "0.75rem" },
  emptyState: { color: "#666", fontSize: "0.8rem" },
  loadingNote: { color: "#666", fontSize: "0.75rem" },
  errorNote: { color: "#b00020", fontSize: "0.75rem" },
  // Round 11: one CARD per vaccine TYPE (replaces the old per-status
  // group) — a colored left border ties it to the same SECTION_COLORS
  // palette app/macro-codes/page.tsx uses for the same family.
  typeCard: {
    border: "1px solid #d5dce3",
    borderLeft: "4px solid",
    borderRadius: 8,
    overflow: "hidden" as const,
    background: "#fff",
  },
  typeHeader: {
    margin: 0,
    padding: "0.4rem 0.75rem",
    fontSize: "0.85rem",
    fontWeight: 800,
    background: "#f4f6f8",
    borderBottom: "1px solid #d5dce3",
  },
  reasonsList: {
    margin: 0,
    padding: "0.4rem 0.75rem 0.1rem",
    listStyle: "none" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.15rem",
  },
  reasonItem: { fontSize: "0.72rem", color: "#333", display: "flex", gap: "0.4rem", flexWrap: "wrap" as const },
  reasonSource: { color: "#1a6ecf", whiteSpace: "nowrap" as const, fontSize: "0.68rem" },
  productRow: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
    padding: "0.5rem 0.75rem",
    borderTop: "1px solid #eee",
  },
  productBlock: { display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" as const },
  productName: { fontWeight: 700, fontSize: "0.78rem", flex: "0 0 auto", minWidth: 0 },
  noMacroNote: { fontSize: "0.7rem", color: "#888", fontWeight: 400 },
  statusBadge: { fontSize: "0.65rem", fontWeight: 700, color: "#555", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
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
  modalField: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" as const, border: "1px solid #bbb" },
  modalLabel: { display: "block", fontWeight: 600, marginBottom: "0.25rem", fontSize: "0.85rem" },
  modalCheckboxRow: { display: "flex", alignItems: "flex-start", gap: "0.4rem", marginBottom: "0.75rem", fontSize: "0.85rem" },
  modalMuted: { color: "#555", fontSize: "0.8rem" },
  modalButton: { padding: "0.3rem 0.6rem", fontSize: "13px" },
} as const;

function statusGroupColor(status: string): string {
  switch (status) {
    case "routine":
      return "#e8f7ee";
    case "risk":
      return "#fff6e0";
    case "consider":
      return "#eef1fb";
    case "caution":
      return "#fdeaea";
    case "not-indicated":
      return "#f2f2f2";
    default:
      return "#f4f6f8";
  }
}

export default function ScreenerPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [ageInput, setAgeInput] = useState("");
  const [conditions, setConditions] = useState<ScreenerConditions>(DEFAULT_CONDITIONS);
  const [priorPneumo, setPriorPneumo] = useState<PriorPneumoHistory>("none");

  // Round 11 (by-type reformat): live vaccines+lots data, fetched the
  // same way app/macro-codes/page.tsx does, so the real per-dose macro
  // code buttons (lib/macro-dose-button.tsx) can be rendered under each
  // eligible product — see this file's header comment.
  const [vaccines, setVaccines] = useState<MacroRowVaccine[]>([]);
  const [lots, setLots] = useState<{ id: string; vaccine_id: string; lot_number: string; expiration: string; status: string }[]>(
    []
  );
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFailure, setCopyFailure] = useState<{ key: string; code: string } | null>(null);

  type ModalState = {
    row: MacroRow;
    label: string;
    lotNumber: string;
    expirationIso: string;
    saveToSystem: boolean;
    submitting: boolean;
    error: string | null;
    copyResult: { copied: boolean; code: string } | null;
    saved: boolean;
  };
  const [modal, setModal] = useState<ModalState | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
        if (!state) {
          setVaccines([]);
          setLots([]);
          setProductsError(null);
        }
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  const loadProducts = useCallback(async (token: string) => {
    setProductsLoading(true);
    setProductsError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [vaccinesRes, lotsRes] = await Promise.all([
        fetch("/api/vaccines?includeInactive=true", { headers }),
        fetch("/api/lots", { headers }),
      ]);
      const [vaccinesData, lotsData] = await Promise.all([vaccinesRes.json(), lotsRes.json()]);

      if (!vaccinesRes.ok) {
        setProductsError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }
      if (!lotsRes.ok) {
        setProductsError(lotsData.error ?? "Could not load lots.");
        return;
      }

      setVaccines(vaccinesData.vaccines ?? []);
      setLots(lotsData.lots ?? []);
    } catch (err) {
      setProductsError(err instanceof Error ? err.message : "Could not load macro codes.");
    } finally {
      setProductsLoading(false);
    }
  }, []);

  const refetchLots = useCallback(async (token: string) => {
    const response = await fetch("/api/lots", { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (response.ok) setLots(data.lots ?? []);
  }, []);

  useEffect(() => {
    if (session) void loadProducts(session.accessToken);
  }, [session, loadProducts]);

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

  function toggleCondition(key: ConditionKey) {
    setConditions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Unchecking a diabetes sub-item never un-checks "Diabetes" itself
      // if the pharmacist explicitly checked it or another sub-item is
      // still checked — the parent stays whatever it was; the DERIVED
      // (rule-matching + display) value is recomputed by lib/screener.ts
      // and by the `diabetesChecked` memo below regardless.
      return next;
    });
  }

  function handleClear() {
    setAgeInput("");
    setConditions(DEFAULT_CONDITIONS);
    setPriorPneumo("none");
  }

  const diabetesSubChecked = DIABETES_SUB_KEYS.some((key) => conditions[key]);
  const ageValue = ageInput.trim() === "" ? null : Number(ageInput);
  const ageValid = ageValue !== null && Number.isFinite(ageValue) && ageValue >= 0 && ageValue <= 120;

  const typeGroups = useMemo<ScreenerTypeGroup[] | null>(() => {
    if (!ageValid || ageValue === null) return null;
    const results: ScreenerResult[] = screen(ageValue, conditions, priorPneumo);
    return groupScreenerResultsByType(results);
  }, [ageValid, ageValue, conditions, priorPneumo]);

  // Real per-product dose data, built the same way app/macro-codes/
  // page.tsx does (buildProductViews -> buildMacroRows), so
  // matchScreenerProducts can hand each eligible screener result its
  // real macro code button(s).
  const rows = useMemo<MacroRow[]>(() => {
    const productViews = buildProductViews(vaccines);
    const activeLotsByVaccineId: Record<string, MacroLotLike[]> = {};
    for (const lot of lots) {
      (activeLotsByVaccineId[lot.vaccine_id] ??= []).push({
        status: lot.status,
        expiration: lot.expiration,
        lot_number: lot.lot_number,
      });
    }
    return buildMacroRows(productViews, vaccines, activeLotsByVaccineId);
  }, [vaccines, lots]);

  function productsFor(screenerId: string): MacroProductGroup[] {
    return matchScreenerProducts(rows, screenerId);
  }

  function rowKeyOf(row: MacroRow): string {
    return macroRowKey(row);
  }

  async function handleCopy(row: MacroRow, label: string) {
    if (!row.macro || !row.shortCode) return;
    if (row.complete) {
      const key = rowKeyOf(row);
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
      label,
      lotNumber: row.lotNumber ?? "",
      expirationIso: row.expirationIso ?? "",
      saveToSystem: row.packageSize !== 1,
      submitting: false,
      error: null,
      copyResult: null,
      saved: false,
    });
  }

  function requestCloseModal() {
    setModal((current) => (current && !current.submitting ? null : current));
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

    // Copy FIRST, before any await touches the network — same Safari/iOS
    // clipboard-permission reasoning as app/macro-codes/page.tsx's
    // handleModalSubmit.
    const copied = finalCode ? await copyToClipboard(finalCode) : false;

    setModal({ ...modal, submitting: true, error: null, copyResult: finalCode ? { copied, code: finalCode } : null });

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
      setModal((current) => (current ? { ...current, submitting: false } : current));
    }
  }

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

  function renderDoseButton(
    dose: { row: MacroRow; label: string },
    colors: SectionColors,
    options: { visibleLabel?: string; subLabel?: string; doseCountInRow: number; reserveSubLabelSlot: boolean }
  ) {
    const key = rowKeyOf(dose.row);
    return renderMacroDoseButton(dose, colors, {
      isCopied: copiedKey === key,
      copyFailureCode: copyFailure?.key === key ? copyFailure.code : null,
      onClick: () => void handleCopy(dose.row, dose.label),
      large: true,
      fitRow: true,
      ...options,
    });
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to use the eligibility screener."
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

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>Vaccine eligibility screener</h1>
      <p style={styles.note}>
        <span>Guidance current as of Sept 2026 (CDC/ACIP); verify before administering.</span>
        <a href="/screener/info" style={styles.infoLink}>
          Full list of conditions and ages →
        </a>
      </p>

      <div style={styles.columns}>
        <div style={styles.formCard}>
          <div style={styles.ageRow}>
            <label style={styles.label} htmlFor="screener-age">
              Age (years)
            </label>
            <input
              id="screener-age"
              type="number"
              min={0}
              max={120}
              step={0.1}
              autoFocus
              style={styles.ageInput}
              value={ageInput}
              onChange={(event) => setAgeInput(event.target.value)}
              placeholder="e.g. 55"
            />
            {ageValue !== null && ageValid && ageValue < 2 && (
              <span style={styles.ageHint}>≈ {Math.round(ageValue * 12)} months</span>
            )}
            {ageInput.trim() !== "" && !ageValid && (
              <span style={{ ...styles.ageHint, color: "#b00020" }}>Enter an age between 0 and 120.</span>
            )}
          </div>

          <p style={styles.conditionsLegend}>Health conditions</p>
          {CONDITION_ITEMS.map((item) => (
            <div key={item.key}>
              {item.groupHeading && <p style={styles.groupHeading}>{item.groupHeading}</p>}
              <label
                style={{
                  ...styles.conditionRow,
                  ...(item.indent ? styles.conditionRowIndent : {}),
                }}
              >
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={item.key === "diabetes" ? conditions.diabetes || diabetesSubChecked : conditions[item.key]}
                  onChange={() => toggleCondition(item.key)}
                />
                <span style={styles.conditionLabel}>{item.label}</span>
              </label>
            </div>
          ))}

          <div style={styles.priorPneumoRow}>
            <label style={styles.label} htmlFor="prior-pneumo-select">
              Prior pneumococcal vaccine history (Prevnar 20 / Capvaxive)
            </label>
            <select
              id="prior-pneumo-select"
              style={{ ...styles.ageInput, marginTop: "0.3rem" }}
              value={priorPneumo}
              onChange={(event) => setPriorPneumo(event.target.value as PriorPneumoHistory)}
            >
              <option value="none">None</option>
              <option value="pcv13">PCV13 only</option>
              <option value="ppsv23">PPSV23 only</option>
              <option value="both">Both PCV13 and PPSV23</option>
              <option value="pcv15_20_21">PCV15, PCV20, or PCV21 (series complete)</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>

          <button type="button" style={styles.clearButton} onClick={handleClear}>
            Clear
          </button>
        </div>

        <div style={styles.resultsWrap}>
          {!typeGroups && <p style={styles.emptyState}>Enter a patient age to see recommendations.</p>}

          {typeGroups && productsLoading && <p style={styles.loadingNote}>Loading macro codes…</p>}
          {typeGroups && productsError && (
            <p style={styles.errorNote}>{productsError} — product names still show, but without copy buttons.</p>
          )}

          {typeGroups &&
            typeGroups.map((group) => {
              const colors = SECTION_COLORS[group.section];
              return (
                <div key={group.section} style={{ ...styles.typeCard, borderLeftColor: colors.border }}>
                  <h2 style={{ ...styles.typeHeader, color: colors.text }}>{macroSectionDisplayName(group.section)}</h2>
                  <ul style={styles.reasonsList}>
                    {group.reasons.map((r) => (
                      <li key={r.reason} style={styles.reasonItem}>
                        <span>{r.reason}</span>
                        <a href={r.sourceUrl} target="_blank" rel="noreferrer" style={styles.reasonSource}>
                          source
                        </a>
                      </li>
                    ))}
                  </ul>

                  {group.results.map((result) => {
                    const matches = productsFor(result.id);
                    const tint = statusGroupColor(result.status);
                    return (
                      <div key={result.id} style={{ ...styles.productRow, background: tint }}>
                        <span style={styles.statusBadge}>{result.status}</span>
                        {matches.length === 0 && (
                          <div style={styles.productBlock}>
                            <span style={styles.productName}>{result.name}</span>
                            <span style={styles.noMacroNote}>— no macro code on file</span>
                          </div>
                        )}
                        {matches.map((product) => {
                          const doseCount = product.doses.length;
                          const reserveSubLabelSlot = product.doses.some((d) => Boolean(d.row.doseInterval));
                          return (
                            <div key={product.productKey} style={styles.productBlock}>
                              <span style={styles.productName}>{product.displayName}</span>
                              <div className="screener-dose-buttons">
                                {product.doses.map((dose) =>
                                  renderDoseButton(dose, colors, {
                                    visibleLabel: doseButtonShortLabel(dose.row, doseCount),
                                    subLabel: dose.row.doseInterval,
                                    doseCountInRow: doseCount,
                                    reserveSubLabelSlot,
                                  })
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
        </div>
      </div>

      {modal && (
        <div
          style={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) requestCloseModal();
          }}
        >
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>
              Enter lot / exp for {modal.row.displayName} dose {modal.row.doseNumber}
            </h2>
            {modal.copyResult && !modal.copyResult.copied && (
              <p style={{ color: "#b00020", fontSize: "0.8rem" }}>
                Couldn&apos;t copy — select and copy manually:
                <br />
                <input
                  type="text"
                  readOnly
                  autoFocus
                  value={modal.copyResult.code}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem", width: "100%", boxSizing: "border-box" }}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </p>
            )}
            <form onSubmit={handleModalSubmit}>
              <label style={styles.modalLabel} htmlFor="screener-modal-lot">
                Lot number
              </label>
              <input
                id="screener-modal-lot"
                style={styles.modalField}
                type="text"
                value={modal.lotNumber}
                onChange={(e) => setModal({ ...modal, lotNumber: e.target.value })}
                autoFocus
              />

              <label style={styles.modalLabel} htmlFor="screener-modal-exp">
                Expiration
              </label>
              <DateTextInput
                value={modal.expirationIso}
                onChange={(iso) => setModal((current) => (current ? { ...current, expirationIso: iso } : current))}
                ariaLabel="Expiration"
                style={styles.modalField}
              />

              <label style={styles.modalCheckboxRow}>
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
                      <span style={styles.modalMuted}>Not recommended for single-dose packages (pkg size 1).</span>
                    </>
                  )}
                </span>
              </label>

              {modal.error && (
                <p style={{ color: "#b00020", fontSize: "0.8rem" }}>
                  {modal.error}
                  {modal.copyResult?.copied && " (the code was already copied to your clipboard)"}
                </p>
              )}

              <p style={{ textAlign: "right", marginBottom: 0 }}>
                <button type="button" style={styles.modalButton} onClick={requestCloseModal} disabled={modal.submitting}>
                  Cancel
                </button>{" "}
                <button
                  type="submit"
                  style={styles.modalButton}
                  disabled={modal.submitting || !modal.lotNumber.trim() || !modal.expirationIso}
                >
                  {modal.submitting ? "Saving…" : "Submit"}
                </button>
              </p>
            </form>
          </div>
        </div>
      )}

      {/* Round 11: dose buttons in a product row always sit on ONE line
       * (never wrap) — see lib/macro-dose-button.tsx's `fitRow` option,
       * used identically here and in app/macro-codes/page.tsx's version
       * C (.macro-dose-buttons-c) so the two pages match. */}
      <style>{`
        .screener-dose-buttons {
          display: flex;
          flex-wrap: nowrap;
          gap: 0.3rem;
          flex: 1 1 auto;
          min-width: 0;
        }
        .macro-dose-button:hover, .macro-dose-button:focus-visible {
          filter: brightness(0.96);
          outline: none;
        }
        .macro-dose-button:disabled { cursor: default; }
        @media (max-width: 640px) {
          .screener-dose-buttons {
            flex-wrap: wrap;
          }
        }
      `}</style>
    </main>
  );
}
