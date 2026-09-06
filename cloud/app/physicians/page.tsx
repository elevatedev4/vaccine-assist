"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";

/**
 * Web edition of the desktop app's Physicians settings tab
 * (desktop/VaccineAssist.Desktop/Views/PhysiciansView.xaml +
 * ViewModels/PhysiciansViewModel.cs) — physicians (display name +
 * Pioneer alternate ID) and the vaccine/age-range -> physician assignment
 * rules. Same GET/POST/DELETE /api/physicians + /api/physician-rules
 * routes the desktop app already uses (no new API route needed), and the
 * same resolved-name display (VaccineDisplayNameFor/PhysicianDisplayNameFor)
 * instead of showing raw GUIDs in the rules list.
 */

type Vaccine = { id: string; name: string };
type Physician = { id: string; display_name: string; alternate_id: string };
type PhysicianRule = {
  id: string;
  physician_id: string;
  vaccine_id: string | null;
  min_age: number | null;
  max_age: number | null;
  priority: number;
};

const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 900 },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  muted: { color: "#555", fontSize: "0.875rem" },
  italic: { fontStyle: "italic", fontSize: "0.85rem" },
  sessionBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.5rem 0.75rem",
    marginBottom: "1rem",
    background: "#f0f4f8",
    borderRadius: 4,
  },
  section: { marginBottom: "2rem" },
  formRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
    alignItems: "flex-end",
    padding: "0.75rem",
    marginBottom: "0.75rem",
    background: "#fafafa",
    border: "1px solid #ddd",
    borderRadius: 4,
  } as const,
  formField: { display: "flex", flexDirection: "column" as const, gap: "0.15rem" },
  narrowInput: { width: 70 },
  infoIcon: { fontWeight: 700, cursor: "help", marginLeft: "0.25rem" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: "0.85rem" },
  th: { textAlign: "left", padding: "0.35rem 0.5rem", borderBottom: "2px solid #ccc" },
  td: { textAlign: "left", padding: "0.3rem 0.5rem", borderBottom: "1px solid #eee" },
} as const;

const ALTERNATE_ID_TOOLTIP =
  "Add an alternate ID in Pioneer first: Prescriber profile > Alternate ID > enter an ID of your choice (no spaces). Enter that same ID here.";

export default function PhysiciansPage() {
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [vaccines, setVaccines] = useState<Vaccine[]>([]);
  const [physicians, setPhysicians] = useState<Physician[]>([]);
  const [rules, setRules] = useState<PhysicianRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newDisplayName, setNewDisplayName] = useState("");
  const [newAlternateId, setNewAlternateId] = useState("");
  const [physicianError, setPhysicianError] = useState<string | null>(null);
  const [physicianBusy, setPhysicianBusy] = useState(false);

  const [newRulePhysicianId, setNewRulePhysicianId] = useState("");
  const [newRuleIsAnyVaccine, setNewRuleIsAnyVaccine] = useState(false);
  const [newRuleVaccineId, setNewRuleVaccineId] = useState("");
  const [newRuleMinAge, setNewRuleMinAge] = useState("");
  const [newRuleMaxAge, setNewRuleMaxAge] = useState("");
  const [newRulePriority, setNewRulePriority] = useState("0");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);

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

  const loadAll = useCallback(async (token: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [physiciansRes, rulesRes, vaccinesRes] = await Promise.all([
        fetch("/api/physicians", { headers }),
        fetch("/api/physician-rules", { headers }),
        fetch("/api/vaccines", { headers }),
      ]);
      const [physiciansData, rulesData, vaccinesData] = await Promise.all([
        physiciansRes.json(),
        rulesRes.json(),
        vaccinesRes.json(),
      ]);

      if (!physiciansRes.ok) {
        setLoadError(physiciansData.error ?? "Could not load physicians.");
        return;
      }
      if (!rulesRes.ok) {
        setLoadError(rulesData.error ?? "Could not load physician rules.");
        return;
      }
      if (!vaccinesRes.ok) {
        setLoadError(vaccinesData.error ?? "Could not load vaccines.");
        return;
      }

      setPhysicians(physiciansData.physicians ?? []);
      setRules(rulesData.physicianRules ?? []);
      const loadedVaccines: Vaccine[] = [...(vaccinesData.vaccines ?? [])].sort(
        (a: Vaccine, b: Vaccine) => a.name.localeCompare(b.name)
      );
      setVaccines(loadedVaccines);
      setNewRuleVaccineId((current) => current || loadedVaccines[0]?.id || "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load physicians.");
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

  async function handleSignOut() {
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // Fall through — clear local state regardless.
    } finally {
      setSession(null);
      setVaccines([]);
      setPhysicians([]);
      setRules([]);
      setLoadError(null);
      setPhysicianError(null);
      setRuleError(null);
    }
  }

  async function handleAddPhysician(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    if (!newDisplayName.trim() || !newAlternateId.trim()) return;
    if (/\s/.test(newAlternateId)) {
      setPhysicianError("Alternate ID must not contain spaces (Pioneer's own Alternate ID rule).");
      return;
    }

    setPhysicianBusy(true);
    setPhysicianError(null);
    try {
      const response = await fetch("/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ display_name: newDisplayName.trim(), alternate_id: newAlternateId.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        setPhysicianError(data.error ?? "Failed to add physician.");
        return;
      }
      setPhysicians((prev) => [...prev, data.physician].sort((a, b) => a.display_name.localeCompare(b.display_name)));
      setNewDisplayName("");
      setNewAlternateId("");
    } catch (err) {
      setPhysicianError(err instanceof Error ? err.message : "Failed to add physician.");
    } finally {
      setPhysicianBusy(false);
    }
  }

  async function handleDeletePhysician(physician: Physician) {
    if (!session) return;
    setPhysicianError(null);
    try {
      const response = await fetch(`/api/physicians/${physician.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setPhysicianError(data.error ?? "Failed to delete physician.");
        return;
      }
      setPhysicians((prev) => prev.filter((p) => p.id !== physician.id));
      // physician_rule rows referencing this physician cascade-delete
      // server-side (supabase/migrations/0007_physicians.sql) — reload
      // rules so the local list doesn't show orphans, same as
      // PhysiciansViewModel.DeletePhysicianAsync.
      await loadAll(session.accessToken);
    } catch (err) {
      setPhysicianError(err instanceof Error ? err.message : "Failed to delete physician.");
    }
  }

  async function handleAddRule(event: FormEvent) {
    event.preventDefault();
    if (!session || !newRulePhysicianId || (!newRuleIsAnyVaccine && !newRuleVaccineId)) return;

    const minAge = newRuleMinAge.trim() === "" ? null : Number(newRuleMinAge);
    const maxAge = newRuleMaxAge.trim() === "" ? null : Number(newRuleMaxAge);
    if (newRuleMinAge.trim() !== "" && !Number.isInteger(minAge)) {
      setRuleError("Min age must be a whole number.");
      return;
    }
    if (newRuleMaxAge.trim() !== "" && !Number.isInteger(maxAge)) {
      setRuleError("Max age must be a whole number.");
      return;
    }
    if (minAge !== null && maxAge !== null && minAge > maxAge) {
      setRuleError("Min age must not be greater than max age.");
      return;
    }
    const priority = newRulePriority.trim() === "" ? 0 : Number(newRulePriority);
    if (!Number.isInteger(priority)) {
      setRuleError("Priority must be a whole number.");
      return;
    }

    setRuleBusy(true);
    setRuleError(null);
    try {
      const response = await fetch("/api/physician-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({
          physician_id: newRulePhysicianId,
          vaccine_id: newRuleIsAnyVaccine ? null : newRuleVaccineId,
          min_age: minAge,
          max_age: maxAge,
          priority,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setRuleError(data.error ?? "Failed to add rule.");
        return;
      }
      setRules((prev) => [...prev, data.physicianRule].sort((a, b) => a.priority - b.priority));
      setNewRuleMinAge("");
      setNewRuleMaxAge("");
      setNewRulePriority("0");
    } catch (err) {
      setRuleError(err instanceof Error ? err.message : "Failed to add rule.");
    } finally {
      setRuleBusy(false);
    }
  }

  async function handleDeleteRule(rule: PhysicianRule) {
    if (!session) return;
    setRuleError(null);
    try {
      const response = await fetch(`/api/physician-rules/${rule.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      const data = await response.json();
      if (!response.ok) {
        setRuleError(data.error ?? "Failed to delete rule.");
        return;
      }
      setRules((prev) => prev.filter((r) => r.id !== rule.id));
    } catch (err) {
      setRuleError(err instanceof Error ? err.message : "Failed to delete rule.");
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
        <p>Use the shared pharmacy login to manage physicians.</p>
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

  const physicianNameById = new Map(physicians.map((p) => [p.id, p.display_name]));
  const vaccineNameById = new Map(vaccines.map((v) => [v.id, v.name]));

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

      <h1>Physicians</h1>

      <p>
        <button style={styles.button} type="button" onClick={() => void loadAll(session.accessToken)} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </p>
      {loadError && <p style={styles.error}>{loadError}</p>}

      <section style={styles.section}>
        <h2>Physicians on file</h2>
        <form onSubmit={handleAddPhysician} style={styles.formRow}>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newDisplayName">
              Display name
            </label>
            <input
              id="newDisplayName"
              type="text"
              placeholder="Kim, David"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              required
            />
          </div>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newAlternateId">
              Alternate ID
              <span style={styles.infoIcon} title={ALTERNATE_ID_TOOLTIP} aria-label={ALTERNATE_ID_TOOLTIP}>
                ⓘ
              </span>
            </label>
            <input
              id="newAlternateId"
              type="text"
              title={ALTERNATE_ID_TOOLTIP}
              value={newAlternateId}
              onChange={(e) => setNewAlternateId(e.target.value)}
              required
            />
          </div>
          <button style={styles.button} type="submit" disabled={physicianBusy}>
            {physicianBusy ? "Adding…" : "Add physician"}
          </button>
        </form>
        {physicianError && <p style={styles.error}>{physicianError}</p>}

        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Display name</th>
              <th style={styles.th}>Alternate ID</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {physicians.map((physician) => (
              <tr key={physician.id}>
                <td style={styles.td}>{physician.display_name}</td>
                <td style={styles.td}>{physician.alternate_id}</td>
                <td style={styles.td}>
                  <button type="button" onClick={() => void handleDeletePhysician(physician)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section style={styles.section}>
        <h2>Assignment rules</h2>
        <form onSubmit={handleAddRule} style={styles.formRow}>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newRulePhysician">
              Physician
            </label>
            <select
              id="newRulePhysician"
              value={newRulePhysicianId}
              onChange={(e) => setNewRulePhysicianId(e.target.value)}
              required
            >
              <option value="">Select a physician</option>
              {physicians.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newRuleVaccine">
              Vaccine
            </label>
            <select
              id="newRuleVaccine"
              value={newRuleVaccineId}
              onChange={(e) => setNewRuleVaccineId(e.target.value)}
              disabled={newRuleIsAnyVaccine}
            >
              {vaccines.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          <div style={styles.formField}>
            <label style={styles.label}>
              <input
                type="checkbox"
                checked={newRuleIsAnyVaccine}
                onChange={(e) => setNewRuleIsAnyVaccine(e.target.checked)}
              />{" "}
              Any vaccine
            </label>
          </div>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newRuleMinAge">
              Min age
            </label>
            <input
              id="newRuleMinAge"
              type="number"
              style={styles.narrowInput}
              title="Blank = no floor"
              value={newRuleMinAge}
              onChange={(e) => setNewRuleMinAge(e.target.value)}
            />
          </div>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newRuleMaxAge">
              Max age
            </label>
            <input
              id="newRuleMaxAge"
              type="number"
              style={styles.narrowInput}
              title="Blank = no ceiling"
              value={newRuleMaxAge}
              onChange={(e) => setNewRuleMaxAge(e.target.value)}
            />
          </div>
          <div style={styles.formField}>
            <label style={styles.label} htmlFor="newRulePriority">
              Priority
            </label>
            <input
              id="newRulePriority"
              type="number"
              style={styles.narrowInput}
              title="Lower number wins a tie between two rules covering the same vaccine (or both wildcard)"
              value={newRulePriority}
              onChange={(e) => setNewRulePriority(e.target.value)}
            />
          </div>
          <button
            style={styles.button}
            type="submit"
            disabled={ruleBusy || !newRulePhysicianId || (!newRuleIsAnyVaccine && !newRuleVaccineId)}
          >
            {ruleBusy ? "Adding…" : "Add rule"}
          </button>
        </form>
        {ruleError && <p style={styles.error}>{ruleError}</p>}
        <p style={styles.italic}>
          A specific-vaccine rule always outranks a fallback (&quot;any vaccine&quot;) rule for the same age,
          regardless of priority.
        </p>

        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Physician</th>
              <th style={styles.th}>Vaccine</th>
              <th style={styles.th}>Min age</th>
              <th style={styles.th}>Max age</th>
              <th style={styles.th}>Priority</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td style={styles.td}>{physicianNameById.get(rule.physician_id) ?? "(unknown physician)"}</td>
                <td style={styles.td}>
                  {rule.vaccine_id === null ? "Any vaccine" : vaccineNameById.get(rule.vaccine_id) ?? "(unknown vaccine)"}
                </td>
                <td style={styles.td}>{rule.min_age ?? "—"}</td>
                <td style={styles.td}>{rule.max_age ?? "—"}</td>
                <td style={styles.td}>{rule.priority}</td>
                <td style={styles.td}>
                  <button type="button" onClick={() => void handleDeleteRule(rule)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
