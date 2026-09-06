"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { todayInChicago } from "@/lib/chicago-date";
import { availableGroupsFor, getVaccineGroup } from "@/lib/vaccine-group-catalog";
import {
  buildClipboardPayload,
  formatExpirationMacro,
  orderByDose,
  pickActiveUnexpiredLot,
  type LotLike,
} from "@/lib/vaccine-entry-payload";

/**
 * Web edition of the desktop app's Ctrl+NumPad2 guided data-entry flow
 * (desktop/VaccineAssist.Desktop/ViewModels/DataEntryPopupViewModel.cs):
 * age -> eligible vaccine GROUP -> PRODUCT -> DOSE (multi-dose only) ->
 * expiration gate -> review, ending in the same "code,lot,exp" clipboard
 * payload the desktop app's "Copy to clipboard" fallback produces
 * (VaccineEntryPayload.ToClipboardPayload). Uses the existing
 * /api/eligibility/for-age and /api/lots routes — no new API route.
 *
 * NO PIONEER AUTOMATION HERE (Will's brief: "except for the ctrl+2
 * control of the computer, obviously") — this page only builds the
 * copy/paste payload. Entering it into PioneerRx still runs from the
 * desktop app's popup.
 */

type EligibilityResult = { status: "allowed" | "warning" | "blocked"; reasons: string[]; warnings: string[] };

type EligibleVaccine = {
  id: string;
  name: string;
  short_code: string;
  ndc: string | null;
  dose: string | null;
  eligibility: EligibilityResult;
};

type Stage = "age" | "group" | "product" | "dose" | "review";

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem", marginBottom: "0.5rem" },
  error: { color: "#b00020" },
  success: { color: "#0a7d27" },
  warning: { color: "#8a5300", background: "#fff4e0", padding: "0.5rem 0.75rem", borderRadius: 4 },
  muted: { color: "#555", fontSize: "0.875rem" },
  note: { color: "#555", fontSize: "0.8rem", fontStyle: "italic", marginTop: "1.5rem" },
  sessionBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.5rem 0.75rem",
    marginBottom: "1rem",
    background: "#f0f4f8",
    borderRadius: 4,
  },
  radioRow: { display: "block", padding: "0.35rem 0", cursor: "pointer" },
  reviewBox: {
    padding: "0.75rem",
    marginBottom: "0.75rem",
    background: "#fafafa",
    border: "1px solid #ddd",
    borderRadius: 4,
  },
  payload: {
    fontFamily: "ui-monospace, monospace",
    padding: "0.5rem",
    background: "#eef",
    borderRadius: 4,
    display: "inline-block",
    marginRight: "0.5rem",
  },
} as const;

export default function DataEntryPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [stage, setStage] = useState<Stage>("age");
  const [ageInput, setAgeInput] = useState("");
  const [age, setAge] = useState<number | null>(null);
  const [eligibleVaccines, setEligibleVaccines] = useState<EligibleVaccine[]>([]);
  const [ageError, setAgeError] = useState<string | null>(null);
  const [ageLoading, setAgeLoading] = useState(false);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedProductName, setSelectedProductName] = useState<string | null>(null);
  const [selectedVaccine, setSelectedVaccine] = useState<EligibleVaccine | null>(null);
  // Mirrors DataEntryPopupViewModel.RefreshSelectedVaccineActiveLotAsync's
  // `SelectedVaccine?.Id != vaccineId` staleness guard: a ref (not state)
  // so refreshActiveLot's in-flight fetch can synchronously check, on
  // BOTH its success and error paths, whether the selection has already
  // moved on to a different vaccine by the time the response lands —
  // otherwise a slow response for vaccine A landing after the user
  // switched to vaccine B would silently apply A's lot to B's payload.
  const selectedVaccineIdRef = useRef<string | null>(null);

  // Expiration gate state — mirrors DataEntryPopupViewModel's
  // SelectedVaccineActiveLot / IsLotExpiredOrMissing / SkipLotAndExpiration.
  const [activeLot, setActiveLot] = useState<LotLike | null | undefined>(undefined); // undefined = not checked yet
  const [lotCheckError, setLotCheckError] = useState<string | null>(null);
  const [skipLotAndExpiration, setSkipLotAndExpiration] = useState(false);
  const [newLotNumber, setNewLotNumber] = useState("");
  const [newLotExpiration, setNewLotExpiration] = useState("");
  const [newLotNote, setNewLotNote] = useState("");
  const [addLotBusy, setAddLotBusy] = useState(false);
  const [addLotError, setAddLotError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

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

  function resetAll() {
    setStage("age");
    setAgeInput("");
    setAge(null);
    setEligibleVaccines([]);
    setAgeError(null);
    setSelectedGroup(null);
    setSelectedProductName(null);
    setSelectedVaccine(null);
    selectedVaccineIdRef.current = null;
    setActiveLot(undefined);
    setLotCheckError(null);
    setSkipLotAndExpiration(false);
    setNewLotNumber("");
    setNewLotExpiration("");
    setNewLotNote("");
    setAddLotError(null);
    setCopied(false);
  }

  async function handleSignOut() {
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Fall through — clear local state regardless.
    } finally {
      setSession(null);
      resetAll();
    }
  }

  async function handleContinueFromAge(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    const parsedAge = Number(ageInput);
    if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 120) {
      setAgeError("Enter a valid patient age first.");
      return;
    }

    setAgeLoading(true);
    setAgeError(null);
    try {
      const response = await fetch(`/api/eligibility/for-age?age=${parsedAge}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setAgeError(data.error ?? "Couldn't check eligible vaccines.");
        return;
      }
      const eligible: EligibleVaccine[] = data.vaccines ?? [];
      if (eligible.length === 0) {
        setAgeError(`No active vaccine on file is eligible for age ${parsedAge}.`);
        return;
      }
      setAge(parsedAge);
      setEligibleVaccines(eligible);
      setStage("group");
    } catch (err) {
      setAgeError(err instanceof Error ? err.message : "Couldn't check eligible vaccines.");
    } finally {
      setAgeLoading(false);
    }
  }

  const groups = availableGroupsFor(eligibleVaccines.map((v) => v.name));

  function productsInGroup(group: string) {
    const inGroup = eligibleVaccines.filter((v) => getVaccineGroup(v.name) === group);
    const names = Array.from(new Set(inGroup.map((v) => v.name)));
    return names.map((name) => {
      const doseRows = orderByDose(
        inGroup.filter((v) => v.name === name),
        (v) => v.dose
      );
      return { name, doseRows, isMultiDose: doseRows.length > 1 };
    });
  }

  function handleSelectGroup(group: string) {
    setSelectedGroup(group);
    setSelectedProductName(null);
    setSelectedVaccine(null);
    selectedVaccineIdRef.current = null;
    setStage("product");
  }

  function handleSelectProduct(productName: string, doseRows: EligibleVaccine[]) {
    setSelectedProductName(productName);
    if (doseRows.length > 1) {
      setStage("dose");
    } else {
      selectVaccine(doseRows[0]);
    }
  }

  function selectVaccine(vaccine: EligibleVaccine) {
    setSelectedVaccine(vaccine);
    selectedVaccineIdRef.current = vaccine.id;
    setActiveLot(undefined);
    setLotCheckError(null);
    setSkipLotAndExpiration(false);
    setNewLotNumber("");
    setNewLotNote("");
    setCopied(false);
    setStage("review");
  }

  // Refresh the earliest-expiration active, unexpired lot whenever the
  // selected vaccine changes — mirrors
  // DataEntryPopupViewModel.RefreshSelectedVaccineActiveLotAsync.
  const refreshActiveLot = useCallback(
    async (vaccineId: string) => {
      if (!session) return;
      setLotCheckError(null);
      try {
        const response = await fetch(`/api/lots?vaccineId=${vaccineId}&status=active`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        const data = await response.json();
        // Selection moved on to a different vaccine while this request
        // was in flight — drop the (now stale) result rather than
        // pairing the currently-selected vaccine's short_code with a
        // different vaccine's lot. Same guard on the error path below.
        if (selectedVaccineIdRef.current !== vaccineId) return;
        if (!response.ok) {
          setLotCheckError(data.error ?? "Couldn't check lot status.");
          setActiveLot(null);
          return;
        }
        const lot = pickActiveUnexpiredLot<LotLike>(data.lots ?? [], todayInChicago());
        setActiveLot(lot);
      } catch (err) {
        if (selectedVaccineIdRef.current !== vaccineId) return;
        setLotCheckError(err instanceof Error ? err.message : "Couldn't check lot status.");
        setActiveLot(null);
      }
    },
    [session]
  );

  useEffect(() => {
    if (stage === "review" && selectedVaccine) {
      void refreshActiveLot(selectedVaccine.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, selectedVaccine?.id]);

  async function handleAddLot(event: FormEvent) {
    event.preventDefault();
    if (!session || !selectedVaccine || !newLotNumber.trim() || !newLotExpiration) return;

    setAddLotBusy(true);
    setAddLotError(null);
    try {
      const response = await fetch("/api/lots", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({
          vaccine_id: selectedVaccine.id,
          lot_number: newLotNumber.trim(),
          expiration: newLotExpiration,
          note: newLotNote.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setAddLotError(data.error ?? "Couldn't add lot.");
        return;
      }
      // A lot just got added for real — any earlier "leave blank and
      // proceed" choice is now stale (mirrors AddLotAsync's own reset).
      setSkipLotAndExpiration(false);
      setNewLotNumber("");
      setNewLotNote("");
      await refreshActiveLot(selectedVaccine.id);
    } catch (err) {
      setAddLotError(err instanceof Error ? err.message : "Couldn't add lot.");
    } finally {
      setAddLotBusy(false);
    }
  }

  function handleBack() {
    setCopied(false);
    switch (stage) {
      case "review": {
        const doseRows = selectedGroup ? productsInGroup(selectedGroup) : [];
        const product = doseRows.find((p) => p.name === selectedProductName);
        setSelectedVaccine(null);
        selectedVaccineIdRef.current = null;
        setActiveLot(undefined);
        if (product?.isMultiDose) {
          setStage("dose");
        } else {
          setStage("product");
        }
        break;
      }
      case "dose":
        setSelectedProductName(null);
        setStage("product");
        break;
      case "product":
        setSelectedGroup(null);
        setStage("group");
        break;
      case "group":
        setEligibleVaccines([]);
        setAge(null);
        setStage("age");
        break;
      case "age":
        break;
    }
  }

  if (!authChecked) {
    return (
      <main style={styles.main}>
        <p>Loading…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main style={styles.main}>
        <p>
          <strong>Not signed in</strong>
        </p>
        <h1>Sign in</h1>
        <p>Use the shared pharmacy login to use the data-entry flow.</p>
        <form onSubmit={handleSignIn}>
          <label style={styles.label} htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            style={styles.field}
            value={signInEmail}
            onChange={(e) => setSignInEmail(e.target.value)}
            required
          />
          <label style={styles.label} htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            style={styles.field}
            value={signInPassword}
            onChange={(e) => setSignInPassword(e.target.value)}
            required
          />
          {signInError && <p style={styles.error}>{signInError}</p>}
          <button style={styles.button} type="submit" disabled={signingIn}>
            {signingIn ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    );
  }

  const isLotExpiredOrMissing = activeLot === null;
  const canCopy = activeLot !== undefined && (!isLotExpiredOrMissing || skipLotAndExpiration);
  const payload =
    selectedVaccine && canCopy
      ? buildClipboardPayload(
          selectedVaccine.short_code,
          activeLot ? activeLot.lot_number : "",
          activeLot ? formatExpirationMacro(activeLot.expiration) : ""
        )
      : null;

  async function handleCopy() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.sessionBar}>
        <span>
          Signed in as <strong>{session.email ?? "unknown user"}</strong>
        </span>
        <button style={styles.button} type="button" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </div>

      <h1>Data entry</h1>

      {stage !== "age" && (
        <button style={styles.button} type="button" onClick={handleBack}>
          ← Back
        </button>
      )}
      {stage !== "age" && (
        <button style={styles.button} type="button" onClick={resetAll}>
          Start over
        </button>
      )}

      {stage === "age" && (
        <form onSubmit={handleContinueFromAge}>
          <label style={styles.label} htmlFor="patientAge">
            Patient age (years)
          </label>
          <input
            id="patientAge"
            type="number"
            min={0}
            max={120}
            style={styles.field}
            value={ageInput}
            onChange={(e) => setAgeInput(e.target.value)}
            required
          />
          {ageError && <p style={styles.error}>{ageError}</p>}
          <button style={styles.button} type="submit" disabled={ageLoading}>
            {ageLoading ? "Checking…" : "Continue"}
          </button>
        </form>
      )}

      {stage === "group" && (
        <>
          <p style={styles.muted}>Age {age} — choose a vaccine group:</p>
          {groups.map((group) => (
            <label key={group} style={styles.radioRow}>
              <input
                type="radio"
                name="group"
                checked={selectedGroup === group}
                onChange={() => handleSelectGroup(group)}
              />{" "}
              {group}
            </label>
          ))}
        </>
      )}

      {stage === "product" && selectedGroup && (
        <>
          <p style={styles.muted}>
            {selectedGroup} — choose a product:
          </p>
          {productsInGroup(selectedGroup).map((product) => (
            <label key={product.name} style={styles.radioRow}>
              <input
                type="radio"
                name="product"
                checked={selectedProductName === product.name}
                onChange={() => handleSelectProduct(product.name, product.doseRows)}
              />{" "}
              {product.name}
            </label>
          ))}
        </>
      )}

      {stage === "dose" && selectedGroup && selectedProductName && (
        <>
          <p style={styles.muted}>{selectedProductName} — choose a dose:</p>
          {productsInGroup(selectedGroup)
            .find((p) => p.name === selectedProductName)
            ?.doseRows.map((doseVaccine) => (
              <label key={doseVaccine.id} style={styles.radioRow}>
                <input
                  type="radio"
                  name="dose"
                  checked={selectedVaccine?.id === doseVaccine.id}
                  onChange={() => selectVaccine(doseVaccine)}
                />{" "}
                Dose {doseVaccine.dose ?? "?"}
              </label>
            ))}
        </>
      )}

      {stage === "review" && selectedVaccine && (
        <>
          <div style={styles.reviewBox}>
            <p>
              <strong>{selectedVaccine.name}</strong> (short code {selectedVaccine.short_code})
              {selectedVaccine.dose ? ` — dose ${selectedVaccine.dose}` : ""}
            </p>

            {selectedVaccine.eligibility.status === "warning" && (
              <p style={styles.warning}>
                {selectedVaccine.eligibility.warnings.map((w, i) => (
                  <span key={i}>
                    {w}
                    <br />
                  </span>
                ))}
              </p>
            )}
            {selectedVaccine.eligibility.status === "allowed" &&
              selectedVaccine.eligibility.warnings.length === 0 && (
                <p style={styles.success}>Eligible for age {age}.</p>
              )}

            {lotCheckError && <p style={styles.error}>{lotCheckError}</p>}

            {activeLot === undefined && <p style={styles.muted}>Checking lot status…</p>}

            {activeLot && (
              <p>
                Lot <strong>{activeLot.lot_number}</strong>, expires {activeLot.expiration}.
              </p>
            )}

            {isLotExpiredOrMissing && !skipLotAndExpiration && (
              <>
                <p style={styles.warning}>
                  No unexpired lot on file for {selectedVaccine.name} — add one below, or choose &quot;Leave
                  lot/expiration blank&quot; to continue without one.
                </p>
                <form onSubmit={handleAddLot} style={{ marginBottom: "0.5rem" }}>
                  <label style={styles.label} htmlFor="deLotNumber">
                    Lot number
                  </label>
                  <input
                    id="deLotNumber"
                    type="text"
                    style={styles.field}
                    value={newLotNumber}
                    onChange={(e) => setNewLotNumber(e.target.value)}
                  />
                  <label style={styles.label} htmlFor="deLotExpiration">
                    Expiration
                  </label>
                  <input
                    id="deLotExpiration"
                    type="date"
                    style={styles.field}
                    value={newLotExpiration}
                    onChange={(e) => setNewLotExpiration(e.target.value)}
                  />
                  <label style={styles.label} htmlFor="deLotNote">
                    Note
                  </label>
                  <input
                    id="deLotNote"
                    type="text"
                    style={styles.field}
                    value={newLotNote}
                    onChange={(e) => setNewLotNote(e.target.value)}
                  />
                  {addLotError && <p style={styles.error}>{addLotError}</p>}
                  <button
                    style={styles.button}
                    type="submit"
                    disabled={addLotBusy || !newLotNumber.trim() || !newLotExpiration}
                  >
                    {addLotBusy ? "Adding…" : "Add lot"}
                  </button>
                  <button style={styles.button} type="button" onClick={() => setSkipLotAndExpiration(true)}>
                    Leave lot/expiration blank and proceed
                  </button>
                </form>
              </>
            )}

            {isLotExpiredOrMissing && skipLotAndExpiration && (
              <p style={styles.muted}>Proceeding without a lot/expiration on the payload below.</p>
            )}
          </div>

          {payload && (
            <div>
              <p>
                <code style={styles.payload}>{payload}</code>
                <button style={styles.button} type="button" onClick={() => void handleCopy()}>
                  Copy
                </button>
                {copied && <span style={styles.success}>Copied.</span>}
              </p>
              <p style={styles.note}>Entry into Pioneer runs from the desktop app.</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
