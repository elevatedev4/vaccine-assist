"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { ORDERING_GROUP_DISPLAY_ORDER } from "@/lib/ordering-group";
import { computeOrderPackages } from "@/lib/vaccine-product-catalog";
import { deriveProductViewFields } from "@/lib/product-view";
import { computeHeadingTotals } from "@/lib/ordering-heading-totals";

/**
 * Web edition of the desktop app's Ordering tab
 * (desktop/VaccineAssist.Desktop/Views/OrderingView.xaml +
 * ViewModels/OrderingViewModel.cs), rebuilt for V-ordering-targets
 * (Will 2026-09-08, msgs 904/908/909 + the V-T25 popup refinement) and
 * V-T26 (Will 2026-09-09):
 *   - one row per PRODUCT/NDC (a multi-dose series like Gardasil no
 *     longer shows 3 times — see GET /api/ordering/recommendation's NDC
 *     collapse)
 *   - rows grouped COVID / Flu / Other only (lib/ordering-group.ts —
 *     Ordering-tab-only coarsening; V-T26 item 5), bold group total rows
 *   - a per-row "Your target" override, autosaving on blur/Enter — the
 *     GROUP-level target input is REMOVED (V-T26 item 6: "Remove group
 *     target for now"; the API/lib behind it are untouched, just unused
 *     here) and a "Copy recommended → Your target" button batch-fills
 *     every active row's override from its recommended target (item 2)
 *   - a shared "Walk-up %" setting (V-T26 item 1) that adjusts the
 *     walk-in buffer baked into recommendedTarget/order server-side
 *   - Doses/pkg, Order (doses), Order (pkg) columns sourced from the
 *     static lib/vaccine-product-catalog.ts lookup (V-T26 item 7)
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
  // V-T26 item 1: the effective walk-up % this response was computed
  // with, and whether that's still just the default (0012 pending).
  walkInPct: number;
  walkInPctPending: boolean;
  // Still returned by the API (GET/PUT /api/ordering/targets and
  // lib/ordering-targets.ts are left intact per Will's brief), but this
  // page no longer reads or renders it — group-scoped overrides are
  // ignored server-side too (V-T26 item 6: "Remove group target for
  // now").
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
  // Compact, spreadsheet-like table (V-T26 item 4, Will 2026-09-09):
  // tight cell padding, small font, tight line-height, thin 1px borders
  // throughout (no more 2px header rule), no extra row spacing.
  table: { borderCollapse: "collapse" as const, width: "100%", fontSize: "13px", lineHeight: 1.2, marginTop: "0.75rem" },
  th: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  thRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" as const },
  td: { textAlign: "left" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right" as const, padding: "2px 6px", borderBottom: "1px solid #eee" },
  // Darkened (Will, 2026-09-09: "Darken the heading color to make it
  // easier to distinguish") from the original #f4f6f8, still light
  // enough for black text to stay readable.
  groupRow: { background: "#d9dde3", fontWeight: 600 },
  // Inputs sized to fit inside a compact cell — fixed ~64px width, thin
  // 1px border, no tall padding.
  targetInput: { width: 64, padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
  walkInInput: { width: 48, padding: "1px 4px", boxSizing: "border-box" as const, border: "1px solid #bbb", fontSize: "13px" },
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

// V-T26 item 3 (Will 2026-09-09): the per-cell "(as of <date>)" suffix
// is gone — the page-level "On-hand data last received" line
// (onHandStatusMessage below) already says when data arrived, so each
// cell just shows the number (or "no data yet").
function onHandDisplay(value: number | null): string {
  if (value === null) return "no data yet";
  return String(value);
}

function onHandStatusMessage(lastReceivedAt: string | null): string {
  return lastReceivedAt
    ? `On-hand data last received: ${new Date(lastReceivedAt).toLocaleString()}`
    : "On-hand data last received: never";
}

/** A single "target on-hand" cell — a row's own NDC-scoped override
 * (V-T26 item 6 removed the group-header version of this control; the
 * group-header cell is now a plain "—" placeholder, see the render
 * below). Local editable text, autosaving on blur/Enter; an empty value
 * on save clears the override (PUT targetOnHand: null). */
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

type EnrichedRow = RecommendationRow & {
  /** productName + (ageRange) when the static catalog
   * (lib/vaccine-product-catalog.ts) knows both, productName alone when
   * it knows the product but not its age range, else today's plain
   * vaccine name (V-T26 item 7). */
  displayName: string;
  /** The shared product-view's NDC: this row's own DB ndc when present,
   * else the researched catalog packageNdc (V-T-ordering-lots-round3,
   * Will: "Look up any missing NDCs" — products whose DB row has no NDC
   * on file, like Capvaxive/Flucelvax PFS/FluMist/mNEXSPIKE/Pneumovax
   * 23/Spikevax, now show their researched package NDC here instead of
   * "—"). Overrides (Your target) still key off row.ndc (the DB value),
   * unchanged. */
  displayNdc: string | null;
  /** Doses per package (renamed "Pkg size" in the table — V-T-ordering-
   * lots-round3), or null when the catalog has no row for this product
   * yet ("—" in the table). */
  dosesPerPackage: number | null;
  /** ceil(order / dosesPerPackage), or null when dosesPerPackage is
   * unknown ("—" in the table). */
  orderPackages: number | null;
};

/** Adds the Pkg size + Order (pkg) + display-name/NDC fields to a
 * recommendation row, via the SHARED lib/product-view.ts lookup (same
 * fields the /lots page computes for the same product — V-T-ordering-
 * lots-round3) — pure/no I/O, so this can run per-row at render time. */
function enrichRow(row: RecommendationRow): EnrichedRow {
  const fields = deriveProductViewFields(row.vaccineName, row.ndc);
  return {
    ...row,
    displayName: fields.displayName,
    displayNdc: fields.ndc,
    dosesPerPackage: fields.packageSize,
    orderPackages: computeOrderPackages(row.order, fields.packageSize),
  };
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
  const [addressCopied, setAddressCopied] = useState(false);

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);

  // V-T26 item 1: the "Walk-up %" input's local editable text + save
  // status, same shape as TargetInput's own local state below but kept
  // inline here since it's a single page-level setting, not a per-row
  // control.
  const [walkInPctText, setWalkInPctText] = useState("");
  const [walkInPctStatus, setWalkInPctStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // V-T26 item 2: "Copy recommended → Your target" — a two-step
  // confirm (Will's brief: "small 'Overwrite existing Your targets?'
  // text with Yes/Cancel") since it overwrites every active NDC row's
  // override at once.
  const [copyConfirming, setCopyConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<{ count: number } | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  function resetAfterSignOut() {
    setData(null);
    setLoadError(null);
    setAddressStatus(null);
    setAddressStatusError(null);
    setUploading(false);
    setUploadError(null);
    setUploadResult(null);
    setAddressCopied(false);
    setShowEmailModal(false);
    setInactiveExpanded(false);
    setWalkInPctText("");
    setWalkInPctStatus("idle");
    setCopyConfirming(false);
    setCopying(false);
    setCopyResult(null);
    setCopyError(null);
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

  // V-T26 item 1: keep the Walk-up % input's local text in sync with
  // the server's effective value whenever a fresh recommendation loads
  // (e.g. right after this or another browser tab saves a new value) —
  // same "sync local editable text from the prop" pattern as
  // TargetInput's own effect above, just inlined for this single field.
  useEffect(() => {
    if (data) setWalkInPctText(String(data.walkInPct));
  }, [data?.walkInPct]);

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

  // Raw PUT /api/ordering/targets call with NO reload afterward — split
  // out from saveTarget below so handleCopyRecommended (V-T26 item 2)
  // can fire one PUT per row in a loop and reload the recommendation
  // ONCE at the end, instead of once per row.
  async function putTargetRequest(
    token: string,
    scope: "ndc" | "group",
    key: string,
    targetOnHand: number | null
  ): Promise<boolean> {
    try {
      const response = await fetch("/api/ordering/targets", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope, key, targetOnHand }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  const saveTarget = useCallback(
    async (scope: "ndc" | "group", key: string, targetOnHand: number | null): Promise<boolean> => {
      if (!session) return false;
      const ok = await putTargetRequest(session.accessToken, scope, key, targetOnHand);
      if (ok) await loadRecommendation(session.accessToken);
      return ok;
    },
    [session, loadRecommendation]
  );

  // V-T26 item 2: "Copy recommended → Your target" — sets every ACTIVE
  // product row's NDC-scoped override to its own recommendedTarget via
  // the existing PUT targets API (no batch endpoint exists, so this is
  // sequential — see putTargetRequest above). A row with no NDC has
  // nothing to save an override under (same rule TargetInput's own
  // `disabled={!row.ndc}` already enforces), so it's skipped, not
  // counted as a failure.
  async function handleCopyRecommended() {
    if (!session || !data) return;
    setCopying(true);
    setCopyError(null);
    setCopyResult(null);
    try {
      const activeRowsWithNdc = data.rows.filter((row) => row.active && row.ndc);
      let count = 0;
      for (const row of activeRowsWithNdc) {
        const ok = await putTargetRequest(session.accessToken, "ndc", row.ndc as string, row.recommendedTarget);
        if (ok) count += 1;
      }
      await loadRecommendation(session.accessToken);
      setCopyResult({ count });
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : "Could not copy targets.");
    } finally {
      setCopying(false);
      setCopyConfirming(false);
    }
  }

  // V-T26 item 1: save the Walk-up % setting on blur/Enter, same
  // autosave shape as TargetInput's own commit() below.
  async function handleSaveWalkInPct() {
    if (!session) return;
    const trimmed = walkInPctText.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setWalkInPctStatus("error");
      return;
    }
    if (data && parsed === data.walkInPct) {
      setWalkInPctStatus("idle");
      return;
    }
    setWalkInPctStatus("saving");
    try {
      const response = await fetch("/api/ordering/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ walkInPct: parsed }),
      });
      if (!response.ok) {
        setWalkInPctStatus("error");
        return;
      }
      setWalkInPctStatus("saved");
      setTimeout(() => setWalkInPctStatus((current) => (current === "saved" ? "idle" : current)), 2000);
      await loadRecommendation(session.accessToken);
    } catch {
      setWalkInPctStatus("error");
    }
  }

  function handleWalkInPctKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  }

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

  // V-T26 item 5 (Will 2026-09-09): COVID/Flu/Other only — the route
  // already emits `row.group` as one of exactly those three names
  // (lib/ordering-group.ts's getOrderingGroup), so this display order is
  // just those three, each appearing exactly once. This also fixes item
  // 8's "Other renders twice" bug: the OLD version of this array was
  // `[...GROUP_DISPLAY_ORDER, OTHER_GROUP]`, but GROUP_DISPLAY_ORDER
  // (lib/vaccine-group-catalog.ts) already ENDS with OTHER_GROUP, so
  // "Other" appeared twice in that array and its entire section
  // (including "Pfizer 3-4"/"Pfizer 5-11") rendered twice.
  const groupedActiveRows = useMemo(() => {
    if (!data) return [];
    const activeRows = data.rows.filter((row) => row.active);
    const byGroup = new Map<string, RecommendationRow[]>();
    for (const row of activeRows) {
      const list = byGroup.get(row.group);
      if (list) list.push(row);
      else byGroup.set(row.group, [row]);
    }
    const order = ORDERING_GROUP_DISPLAY_ORDER.filter((group) => byGroup.has(group));
    // Any group name not in the known display order (shouldn't happen —
    // the route only ever emits COVID/Flu/Other — but defensive) still
    // gets shown, appended at the end, at most once.
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
          accept=".xlsx,.csv,.txt,.pdf"
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
        {!copyConfirming ? (
          <button
            style={styles.button}
            type="button"
            onClick={() => setCopyConfirming(true)}
            disabled={!data || targetsPending}
          >
            Copy recommended → Your target
          </button>
        ) : (
          <span style={styles.muted}>
            Overwrite existing Your targets?{" "}
            <button style={styles.button} type="button" onClick={() => void handleCopyRecommended()} disabled={copying}>
              {copying ? "Copying…" : "Yes"}
            </button>{" "}
            <button style={styles.button} type="button" onClick={() => setCopyConfirming(false)} disabled={copying}>
              Cancel
            </button>
          </span>
        )}
        <span style={styles.muted}>
          <label htmlFor="walk-in-pct">Walk-up %</label>{" "}
          <input
            id="walk-in-pct"
            type="number"
            min={0}
            max={100}
            step={1}
            style={styles.walkInInput}
            value={walkInPctText}
            disabled={data?.walkInPctPending}
            title={data?.walkInPctPending ? "saves after a 1-minute database step" : undefined}
            onChange={(e) => setWalkInPctText(e.target.value)}
            onBlur={() => void handleSaveWalkInPct()}
            onKeyDown={handleWalkInPctKeyDown}
          />
          {walkInPctStatus === "saving" && <span style={styles.saveStatus}>saving…</span>}
          {walkInPctStatus === "saved" && <span style={{ ...styles.saveStatus, color: "#0a7d27" }}>saved</span>}
          {walkInPctStatus === "error" && <span style={{ ...styles.saveStatus, color: "#b00020" }}>error</span>}
          {data?.walkInPctPending && <span style={styles.saveStatus}>saves after a 1-minute database step</span>}
        </span>
        {showEmailSetupLink && (
          <a href="#" style={styles.link} onClick={(e) => { e.preventDefault(); setShowEmailModal(true); }}>
            Email-in setup
          </a>
        )}
      </div>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {addressStatusError && <p style={styles.error}>{addressStatusError}</p>}
      {uploadError && <p style={styles.error}>{uploadError}</p>}
      {copyError && <p style={styles.error}>{copyError}</p>}
      {copyResult && (
        <p style={styles.success}>
          Copied {copyResult.count} target{copyResult.count === 1 ? "" : "s"}.
        </p>
      )}
      {uploadResult && (
        <p style={styles.success}>
          Imported {uploadResult.inserted} row{uploadResult.inserted === 1 ? "" : "s"} (
          {uploadResult.inserted - uploadResult.unmatched.length} matched).
          {uploadResult.unmatched.length > 0 ? ` Unmatched: ${uploadResult.unmatched.join(", ")}.` : ""}
        </p>
      )}

      {data && <p style={styles.muted}>{onHandStatusMessage(data.onHandLastReceivedAt)}</p>}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.th}>NDC</th>
            <th style={styles.thRight}>Pkg size</th>
            <th style={styles.thRight}>Upcoming 7d</th>
            <th style={styles.th}>On hand</th>
            <th style={styles.thRight}>Recommended target</th>
            <th style={styles.th}>Your target</th>
            <th style={styles.thRight}>Order (doses)</th>
            <th style={styles.thRight}>Order (pkg)</th>
          </tr>
        </thead>
        <tbody>
          {groupedActiveRows.map(({ group, rows }) => {
            const enrichedRows = rows.map(enrichRow);
            // V-T-ordering-lots-round3 (Will 2026-09-09, verbatim): "Leave
            // off the targets for headings. Just leave the target and
            // order all blank on those rows." — see
            // lib/ordering-heading-totals.ts's doc comment.
            const totals = computeHeadingTotals(enrichedRows);

            return (
              <Fragment key={group}>
                <tr style={styles.groupRow}>
                  <td style={styles.td}>{group}</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>{totals.upcoming7d}</td>
                  <td style={styles.td}>{totals.onHand}</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.td}>—</td>
                  <td style={styles.tdRight}>—</td>
                  <td style={styles.tdRight}>—</td>
                </tr>
                {enrichedRows.map((row) => (
                  <tr key={row.key}>
                    <td style={{ ...styles.td, paddingLeft: "1.5rem" }}>{row.displayName}</td>
                    <td style={styles.td}>{row.displayNdc ?? "—"}</td>
                    <td style={styles.tdRight}>{row.dosesPerPackage ?? "—"}</td>
                    <td style={styles.tdRight}>{row.upcoming7d}</td>
                    <td style={styles.td}>{onHandDisplay(row.onHand)}</td>
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
                    <td style={styles.tdRight}>{row.orderPackages ?? "—"}</td>
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
                  <th style={styles.thRight}>Pkg size</th>
                  <th style={styles.thRight}>Upcoming 7d</th>
                  <th style={styles.th}>On hand</th>
                  <th style={styles.thRight}>Recommended target</th>
                  <th style={styles.thRight}>Order (doses)</th>
                  <th style={styles.thRight}>Order (pkg)</th>
                </tr>
              </thead>
              <tbody>
                {inactiveRows.map(enrichRow).map((row) => (
                  <tr key={row.key}>
                    <td style={styles.td}>{row.displayName}</td>
                    <td style={styles.td}>{row.displayNdc ?? "—"}</td>
                    <td style={styles.tdRight}>{row.dosesPerPackage ?? "—"}</td>
                    <td style={styles.tdRight}>{row.upcoming7d}</td>
                    <td style={styles.td}>{onHandDisplay(row.onHand)}</td>
                    <td style={styles.tdRight}>{row.recommendedTarget}</td>
                    <td style={styles.tdRight}>{row.order}</td>
                    <td style={styles.tdRight}>{row.orderPackages ?? "—"}</td>
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
                  accept=".xlsx,.csv,.txt,.pdf"
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
