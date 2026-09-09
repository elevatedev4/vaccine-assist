"use client";

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Web edition of the desktop app's Ordering tab
 * (desktop/VaccineAssist.Desktop/Views/OrderingView.xaml +
 * ViewModels/OrderingViewModel.cs) — reorder recommendations from GET
 * /api/ordering/recommendation (no new API route; see that route's
 * RESPONSE CONTRACT doc comment). Same sort order
 * (recommendedOrder desc, then vaccineName asc) and on-hand display
 * ("{qty} (as of {date})" / "no data yet") as OrderingViewModel.
 */

type RecommendationRow = {
  vaccineId: string;
  vaccineName: string;
  upcoming7d: number;
  onHand: number | null;
  onHandAsOf: string | null;
  recommendedOrder: number;
};

type RecommendationResponse = {
  onHandLastReceivedAt: string | null;
  rows: RecommendationRow[];
};

// V-onhand-account-address (Will 2026-09-08): the per-account on-hand
// email address — see GET /api/on-hand/address's RESPONSE CONTRACT.
type OnHandAddressStatus =
  | { pending: true }
  | { pending?: false; address: string; token: string; lastReceivedAt: string | null; hasData: boolean };

type UploadResult = { inserted: number; unmatched: string[] };

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  muted: { color: "#555", fontSize: "0.875rem" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  thRight: { textAlign: "right", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  tdRight: { textAlign: "right", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
  setupCard: {
    border: "1px solid #ddd",
    borderRadius: 6,
    padding: "1rem 1.25rem",
    marginBottom: "1.5rem",
    maxWidth: 640,
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
  },
} as const;

function onHandDisplay(row: RecommendationRow): string {
  if (row.onHand === null) return "no data yet";
  if (row.onHandAsOf) {
    const asOf = new Date(row.onHandAsOf);
    return `${row.onHand} (as of ${asOf.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`;
  }
  return String(row.onHand);
}

function onHandStatusMessage(lastReceivedAt: string | null): string {
  return lastReceivedAt
    ? `On-hand data last received: ${new Date(lastReceivedAt).toLocaleString()}`
    : "On-hand data last received: never";
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

  // V-onhand-account-address (Will 2026-09-08): drives the setup card
  // below when hasData is false, and the "Email-in address: Settings"
  // line once it's true.
  const [addressStatus, setAddressStatus] = useState<OnHandAddressStatus | null>(null);
  const [addressStatusError, setAddressStatusError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setData(null);
    setLoadError(null);
    setAddressStatus(null);
    setAddressStatusError(null);
    setUploading(false);
    setUploadError(null);
    setUploadResult(null);
    setAddressCopied(false);
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

  async function handleUploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input immediately so selecting the same filename again
    // later still fires onChange.
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
      // hasData just flipped (or more rows landed) — refresh both the
      // setup-card gate and the recommendation table.
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

  const rows = data
    ? [...data.rows].sort((a, b) => {
        if (a.recommendedOrder !== b.recommendedOrder) return b.recommendedOrder - a.recommendedOrder;
        return a.vaccineName.localeCompare(b.vaccineName);
      })
    : [];

  // Only known-false (not "still loading" or "pending migration") swaps
  // the table for the setup card — see the RESPONSE CONTRACT doc comment
  // on GET /api/on-hand/address.
  const showSetupCard = !!addressStatus && !("pending" in addressStatus && addressStatus.pending) && !addressStatus.hasData;
  const address = addressStatus && !("pending" in addressStatus && addressStatus.pending) ? addressStatus.address : null;

  return (
    <main style={styles.main}>
      <h1>Ordering recommendations</h1>

      <p>
        <button
          style={styles.button}
          type="button"
          onClick={() => void loadRecommendation(session.accessToken)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      {loadError && <p style={styles.error}>{loadError}</p>}
      {addressStatusError && <p style={styles.error}>{addressStatusError}</p>}

      {showSetupCard && address ? (
        <div style={styles.setupCard}>
          <h2 style={{ marginTop: 0 }}>Get your on-hand data flowing</h2>
          <p>
            <span style={styles.codeBlock}>{address}</span>
            <button style={styles.button} type="button" onClick={() => void handleCopyAddress(address)}>
              {addressCopied ? "Copied!" : "Copy"}
            </button>
          </p>
          <p style={styles.muted}>
            Point PioneerRx&apos;s daily on-hand report at this address.
            <br />
            One line per vaccine: &quot;VaccineName, Quantity&quot;.
            <br />
            Reports arrive within a minute of being sent.
          </p>
          <p>
            <label style={styles.label} htmlFor="onHandUpload">
              Or upload your first on-hand file now:
            </label>
            <input id="onHandUpload" type="file" accept=".txt,.csv" onChange={(e) => void handleUploadFile(e)} disabled={uploading} />
          </p>
          {uploading && <p style={styles.muted}>Uploading…</p>}
          {uploadError && <p style={styles.error}>{uploadError}</p>}
          {uploadResult && (
            <p style={styles.success}>
              Imported {uploadResult.inserted} line{uploadResult.inserted === 1 ? "" : "s"}
              {uploadResult.unmatched.length > 0 ? ` (${uploadResult.unmatched.length} unmatched: ${uploadResult.unmatched.join(", ")})` : ""}.
            </p>
          )}
        </div>
      ) : (
        <>
          {data && <p style={styles.muted}>{onHandStatusMessage(data.onHandLastReceivedAt)}</p>}
          {addressStatus && !("pending" in addressStatus && addressStatus.pending) && addressStatus.hasData && (
            <p style={styles.muted}>
              Email-in address: <a href="/settings">Settings</a>
            </p>
          )}
        </>
      )}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Vaccine</th>
            <th style={styles.thRight}>Upcoming 7d</th>
            <th style={styles.th}>On hand</th>
            <th style={styles.thRight}>Recommended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.vaccineId}>
              <td style={styles.td}>{row.vaccineName}</td>
              <td style={styles.tdRight}>{row.upcoming7d}</td>
              <td style={styles.td}>{onHandDisplay(row)}</td>
              <td style={styles.tdRight}>{row.recommendedOrder}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
