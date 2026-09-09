"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { GROUP_DISPLAY_ORDER, OTHER_GROUP } from "@/lib/vaccine-group-catalog";

/**
 * Web edition of the desktop app's Ordering tab
 * (desktop/VaccineAssist.Desktop/Views/OrderingView.xaml +
 * ViewModels/OrderingViewModel.cs), rebuilt for V-ordering-targets
 * (Will 2026-09-08, msgs 904/908/909 + the V-T25 popup refinement):
 *   - one row per PRODUCT/NDC (a multi-dose series like Gardasil no
 *     longer shows 3 times — see GET /api/ordering/recommendation's NDC
 *     collapse)
 *   - rows grouped by vaccine group, with a group header row + editable
 *     group-level target
 *   - a per-row "Your target" override, autosaving on blur/Enter
 *   - inactive vaccines collapsed into their own section below
 *   - a modal nudging staff to set up the daily on-hand EMAIL (shown
 *     until one has actually arrived — a manual upload doesn't count,
 *     see GET /api/on-hand/address's lastReceivedAt), plus an always-
 *     visible "Upload on-hand file" button next to Refresh
 */

type RecommendationRow = {
  key: string;
  vaccineName: string;
  ndc: string | null;
  group: string;
  active: boolean;
  upcoming7d: number;
  onHand: number | null;
  onHandAsOf: string | null;
  recommendedTarget: number;
  targetOnHand: number | null;
  effectiveTarget: number;
  targetSource: "ndc" | "group" | "recommended";
  order: number;
};

type RecommendationResponse = {
  onHandLastReceivedAt: string | null;
  targetsPending: boolean;
  groupTargets: Record<string, number>;
  rows: RecommendationRow[];
};

// V-onhand-account-address (Will 2026-09-08): the per-account on-hand
// email address — see GET /api/on-hand/address's RESPONSE CONTRACT.
// `lastReceivedAt` only ever reflects an actual EMAIL arriving (the
// upload route deliberately never touches it) — see the V-T25 popup
// logic below.
type OnHandAddressStatus =
  | { pending: true }
  | { pending?: false; address: string; token: string; lastReceivedAt: string | null; hasData: boolean };

type UploadResult = { inserted: number; unmatched: string[] };

const EMAIL_MODAL_DISMISSED_KEY = "ordering-email-setup-dismissed";

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 1000 },
  toolbar: { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" as const, marginBottom: "0.5rem" },
  button: { padding: "0.5rem 1rem" },
  link: { fontSize: "0.85rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  muted: { color: "#555", fontSize: "0.875rem" },
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "0.85rem", marginTop: "1rem" },
  th: { textAlign: "left" as const, padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  thRight: { textAlign: "right" as const, padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left" as const, padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right" as const, padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  groupRow: { background: "#f4f6f8", fontWeight: 600 },
  targetInput: { width: "4.5rem", padding: "0.2rem 0.35rem", boxSizing: "border-box" as const },
  saveStatus: { fontSize: "0.7rem", marginLeft: "0.35rem" },
  inactiveToggle: { marginTop: "1.5rem", background: "none", border: "1px solid #ccc", borderRadius: 4, padding: "0.4rem 0.75rem", cursor: "pointer" },
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
    maxWidth: 480,
    width: "100%",
    boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
  },
  codeBlock: {
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.9rem",
    background: "#f4f4f4",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.6rem 0.75rem",
    display: "inline-block",
    marginRight: "0.5rem",
    wordBreak: "break-all" as const,
  },
} as const;

function onHandDisplay(value: number | null, asOf: string | null): string {
  if (value === null) return "no data yet";
  if (asOf) {
    const date = new Date(asOf);
    return `${value} (as of ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
  }
  return String(value);
}

function onHandStatusMessage(lastReceivedAt: string | null): string {
  return lastReceivedAt
    ? `On-hand data last received: ${new Date(lastReceivedAt).toLocaleString()}`
    : "On-hand data last received: never";
}

/** A single "target on-hand" cell — used for both a row's own NDC-scoped
 * override and a group header's group-scoped override. Local editable
 * text, autosaving on blur/Enter; an empty value on save clears the
 * override (PUT targetOnHand: null). */
function TargetInput({
  value,
  disabled,
  disabledTitle,
  onSave,
}: {
  value: number | null;
  disabled: boolean;
  disabledTitle?: string;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setText(value === null ? "" : String(value));
  }, [value]);

  async function commit() {
    const trimmed = text.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setStatus("error");
      return;
    }
    // No-op save (value unchanged) — skip the request but still clear any
    // stale save/error indicator from a previous edit.
    if (parsed === value) {
      setStatus("idle");
      return;
    }
    setStatus("saving");
    const ok = await onSave(parsed);
    setStatus(ok ? "saved" : "error");
    if (ok) setTimeout(() => setStatus((current) => (current === "saved" ? "idle" : current)), 2000);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  }

  return (
    <span>
      <input
        type="number"
        min={0}
        step={1}
        style={styles.targetInput}
        value={text}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={handleKeyDown}
      />
      {status === "saving" && <span style={styles.saveStatus}>saving…</span>}
      {status === "saved" && <span style={{ ...styles.saveStatus, color: "#0a7d27" }}>saved</span>}
      {status === "error" && <span style={{ ...styles.saveStatus, color: "#b00020" }}>error</span>}
    </span>
  );
}

function sortRows(rows: RecommendationRow[]): RecommendationRow[] {
  return [...rows].sort((a, b) => {
    if (a.order !== b.order) return b.order - a.order;
    return a.vaccineName.localeCompare(b.vaccineName);
  });
}

export default function OrderingPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [data, setData] = useState<RecommendationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [addressStatus, setAddressStatus] = useState<OnHandAddressStatus | null>(null);
  const [addressStatusError, setAddressStatusError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadAsOf, setUploadAsOf] = useState<Date | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);

  function resetAfterSignOut() {
    setData(null);
    setLoadError(null);
    setAddressStatus(null);
    setAddressStatusError(null);
    setUploading(false);
    setUploadError(null);
    setUploadResult(null);
    setUploadAsOf(null);
    setAddressCopied(false);
    setShowEmailModal(false);
    setInactiveExpanded(false);
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

  const loadRecommendation = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/ordering/recommendation", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      if (!response.ok) {
        setLoadError(body.error ?? "Could not load ordering recommendations.");
        return;
      }
      setData(body as RecommendationResponse);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load ordering recommendations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadRecommendation(session.accessToken);
  }, [session, loadRecommendation]);

  const loadAddressStatus = useCallback(async (token: string) => {
    setAddressStatusError(null);
    try {
      const response = await fetch("/api/on-hand/address", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setAddressStatusError("Could not load the on-hand report email address.");
        return;
      }
      const body: OnHandAddressStatus = await response.json();
      setAddressStatus(body);
    } catch (err) {
      setAddressStatusError(err instanceof Error ? err.message : "Could not load the on-hand report email address.");
    }
  }, []);

  useEffect(() => {
    if (session) void loadAddressStatus(session.accessToken);
  }, [session, loadAddressStatus]);

  // V-T25: pop the "set up your daily email" modal automatically once we
  // know this account has never received an EMAIL (lastReceivedAt is
  // strictly about the email path — see the type comment above), unless
  // it was already dismissed this browser session.
  useEffect(() => {
    if (!addressStatus || ("pending" in addressStatus && addressStatus.pending)) return;
    if (addressStatus.lastReceivedAt !== null) {
      setShowEmailModal(false);
      return;
    }
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(EMAIL_MODAL_DISMISSED_KEY) === "1";
    } catch {
      // sessionStorage unavailable (private mode, etc.) — just show it.
    }
    if (!dismissed) setShowEmailModal(true);
  }, [addressStatus]);

  function handleCloseEmailModal() {
    setShowEmailModal(false);
    try {
      sessionStorage.setItem(EMAIL_MODAL_DISMISSED_KEY, "1");
    } catch {
      // Soft failure — the modal just won't remember being dismissed.
    }
  }

  async function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !session) return;

    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/on-hand/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) {
        setUploadError(body.error ?? "Could not upload the file.");
        return;
      }
      setUploadResult(body as UploadResult);
      setUploadAsOf(new Date());
      await Promise.all([loadAddressStatus(session.accessToken), loadRecommendation(session.accessToken)]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not upload the file.");
    } finally {
      setUploading(false);
    }
  }

  async function handleCopyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch {
      // Clipboard API unavailable/denied — the address is still visible
      // and selectable in the code box, so this is a soft failure.
    }
  }

  const saveTarget = useCallback(
    async (scope: "ndc" | "group", key: string, targetOnHand: number | null): Promise<boolean> => {
      if (!session) return false;
      try {
        const response = await fetch("/api/ordering/targets", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
          body: JSON.stringify({ scope, key, targetOnHand }),
        });
        if (!response.ok) return false;
        await loadRecommendation(session.accessToken);
        return true;
      } catch {
        return false;
      }
    },
    [session, loadRecommendation]
  );

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data: signInData, error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error || !signInData.session) {
        setSignInError(error?.message ?? "Sign-in failed.");
        return;
      }
      setSession(toSessionState(signInData.session));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  const groupedActiveRows = useMemo(() => {
    if (!data) return [];
    const activeRows = data.rows.filter((row) => row.active);
    const byGroup = new Map<string, RecommendationRow[]>();
    for (const row of activeRows) {
      const list = byGroup.get(row.group);
      if (list) list.push(row);
      else byGroup.set(row.group, [row]);
    }
    const order = [...GROUP_DISPLAY_ORDER, OTHER_GROUP].filter((group) => byGroup.has(group));
    // Any group name not in the known display order (shouldn't happen,
    // but defensive) still gets shown, appended at the end.
    for (const group of byGroup.keys()) {
      if (!order.includes(group)) order.push(group);
    }
    return order.map((group) => ({ group, rows: sortRows(byGroup.get(group) ?? []) }));
  }, [data]);

  const inactiveRows = useMemo(() => {
    if (!data) return [];
    return sortRows(data.rows.filter((row) => !row.active));
  }, [data]);

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view ordering recommendations."
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

  const targetsPending = data?.targetsPending ?? false;
  const address = addressStatus && !("pending" in addressStatus && addressStatus.pending) ? addressStatus.address : null;
  const showEmailSetupLink =
    !!addressStatus && !("pending" in addressStatus && addressStatus.pending) && addressStatus.lastReceivedAt === null;

  const uploadControl = (
    <>
      <label style={{ ...styles.button, border: "1px solid #888", borderRadius: 4, cursor: uploading ? "default" : "pointer", display: "inline-block" }}>
        {uploading ? "Uploading…" : "Upload on-hand file"}
        <input
          type="file"
          accept=".xlsx,.csv,.txt"
          onChange={(e) => void handleUploadFile(e)}
          disabled={uploading}
          style={{ display: "none" }}
        />
      </label>
    </>
  );

  return (
    <main style={styles.main}>
      <h1>Ordering recommendations</h1>

      <div style={styles.toolbar}>
        <button style={styles.button} type="button" onClick={() => void loadRecommendation(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {uploadControl}
        {showEmailSetupLink && (
          <a href="#" style={styles.link} onClick={(e) => { e.preventDefault(); setShowEmailModal(true); }}>
            Email-in setup
          </a>
        )}
      </div>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {addressStatusError && <p style={styles.error}>{addressStatusError}</p>}
      {uploadError && <p style={styles.error}>{uploadError}</p>}
      {uploadResult && (
        <p style={styles.success}>
          Imported {uploadResult.inserted} row{uploadResult.inserted === 1 ? "" : "s"} (
          {uploadResult.inserted - uploadResult.unmatched.length} matched)
          {uploadAsOf ? ` — as of ${uploadAsOf.toLocaleString()}` : ""}.
          {uploadResult.unmatched.length > 0 ? ` Unmatched: ${uploadResult.unmatched.join(", ")}.` : ""}
        </p>
      )}

      {data && <p style={styles.muted}>{onHandStatusMessage(data.onHandLastReceivedAt)}</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.thRight}>Upcoming 7d</th>
            <th style={styles.th}>On hand</th>
            <th style={styles.thRight}>Recommended target</th>
            <th style={styles.th}>Your target</th>
            <th style={styles.thRight}>Order</th>
          </tr>
        </thead>
        <tbody>
          {groupedActiveRows.map(({ group, rows }) => {
            const totals = rows.reduce(
              (acc, row) => ({
                upcoming7d: acc.upcoming7d + row.upcoming7d,
                onHand: acc.onHand + (row.onHand ?? 0),
                recommendedTarget: acc.recommendedTarget + row.recommendedTarget,
                order: acc.order + row.order,
              }),
              { upcoming7d: 0, onHand: 0, recommendedTarget: 0, order: 0 }
            );
            const groupTargetValue = data?.groupTargets[group] ?? null;

            return (
              <Fragment key={group}>
                <tr style={styles.groupRow}>
                  <td style={styles.td}>{group}</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.tdRight}>{totals.upcoming7d}</td>
                  <td style={styles.td}>{totals.onHand}</td>
                  <td style={styles.tdRight}>{totals.recommendedTarget}</td>
                  <td style={styles.td}>
                    <TargetInput
                      value={groupTargetValue}
                      disabled={targetsPending}
                      disabledTitle="activates after the database step"
                      onSave={(value) => saveTarget("group", group, value)}
                    />
                  </td>
                  <td style={styles.tdRight}>{totals.order}</td>
                </tr>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ ...styles.td, paddingLeft: "1.5rem" }}>{row.vaccineName}</td>
                    <td style={styles.td}>{row.ndc ?? "—"}</td>
                    <td style={styles.tdRight}>{row.upcoming7d}</td>
                    <td style={styles.td}>{onHandDisplay(row.onHand, row.onHandAsOf)}</td>
                    <td style={styles.tdRight}>{row.recommendedTarget}</td>
                    <td style={styles.td}>
                      <TargetInput
                        value={row.targetOnHand}
                        disabled={targetsPending || !row.ndc}
                        disabledTitle={targetsPending ? "activates after the database step" : "no NDC on file for this product"}
                        onSave={(value) => (row.ndc ? saveTarget("ndc", row.ndc, value) : Promise.resolve(false))}
                      />
                    </td>
                    <td style={styles.tdRight}>{row.order}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {inactiveRows.length > 0 && (
        <>
          <button type="button" style={styles.inactiveToggle} onClick={() => setInactiveExpanded((v) => !v)}>
            {inactiveExpanded ? "▾" : "▸"} Inactive vaccines ({inactiveRows.length})
          </button>
          {inactiveExpanded && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Vaccine</th>
                  <th style={styles.th}>NDC</th>
                  <th style={styles.thRight}>Upcoming 7d</th>
                  <th style={styles.th}>On hand</th>
                  <th style={styles.thRight}>Recommended target</th>
                  <th style={styles.thRight}>Order</th>
                </tr>
              </thead>
              <tbody>
                {inactiveRows.map((row) => (
                  <tr key={row.key}>
                    <td style={styles.td}>{row.vaccineName}</td>
                    <td style={styles.td}>{row.ndc ?? "—"}</td>
                    <td style={styles.tdRight}>{row.upcoming7d}</td>
                    <td style={styles.td}>{onHandDisplay(row.onHand, row.onHandAsOf)}</td>
                    <td style={styles.tdRight}>{row.recommendedTarget}</td>
                    <td style={styles.tdRight}>{row.order}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {showEmailModal && address && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modalCard}>
            <h2 style={{ marginTop: 0 }}>Set up the daily on-hand email</h2>
            <p>
              <span style={styles.codeBlock}>{address}</span>
              <button style={styles.button} type="button" onClick={() => void handleCopyAddress(address)}>
                {addressCopied ? "Copied!" : "Copy"}
              </button>
            </p>
            <p style={styles.muted}>
              Point PioneerRx&apos;s daily on-hand report at this address.
              <br />
              Attach (or paste) the current-BOH export.
              <br />
              Reports arrive within a minute of being sent.
            </p>
            <p>
              <label style={{ ...styles.button, border: "1px solid #888", borderRadius: 4, cursor: uploading ? "default" : "pointer", display: "inline-block" }}>
                {uploading ? "Uploading…" : "Or upload a file now"}
                <input
                  type="file"
                  accept=".xlsx,.csv,.txt"
                  onChange={(e) => void handleUploadFile(e)}
                  disabled={uploading}
                  style={{ display: "none" }}
                />
              </label>
            </p>
            {uploadError && <p style={styles.error}>{uploadError}</p>}
            <p style={{ textAlign: "right", marginBottom: 0 }}>
              <button style={styles.button} type="button" onClick={handleCloseEmailModal}>
                Close
              </button>
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
