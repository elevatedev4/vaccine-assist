"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import { availableGroupsFor, getVaccineGroup } from "@/lib/vaccine-group-catalog";
import { parseRuleTargetValue } from "@/lib/physician-rule-target";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";

/**
 * Web edition of the desktop app's Physicians settings tab
 * (desktop/VaccineAssist.Desktop/Views/PhysiciansView.xaml +
 * ViewModels/PhysiciansViewModel.cs) — physicians (display name +
 * Pioneer alternate ID) and the vaccine/age-range -> physician assignment
 * rules. Same GET/POST/DELETE /api/physicians + /api/physician-rules
 * routes the desktop app already uses (no new API route needed), and the
 * same resolved-name display (VaccineDisplayNameFor/PhysicianDisplayNameFor)
 * instead of showing raw GUIDs in the rules list.
 *
 * V-cloud-tabs (Will, 2026-09-05/07, rule #5): the vaccine dropdown is
 * now grouped by catalog TYPE (flu, COVID, Tdap, pneumonia, ... — see
 * lib/vaccine-group-catalog.ts), with an "All <group> vaccines" option at
 * the top of each optgroup so a rule can target the whole group instead
 * of one product. The dropdown's single value is either
 * `group:<GroupName>` or `id:<vaccineId>` (parseRuleTargetValue below);
 * the "All <group> vaccines" options are hidden (with a "pending
 * migration" note) when the backend reports vaccine_group isn't
 * supported yet (physician_rule.vaccine_group, an additive column — see
 * supabase/migrations/0009_lots_bud_vaccine_defaults.sql and
 * lib/schema-degradation.ts) — display grouping itself has no schema
 * dependency and always works.
 */

type Vaccine = { id: string; name: string };
type Physician = { id: string; display_name: string; alternate_id: string };
type PhysicianRule = {
  id: string;
  physician_id: string;
  vaccine_id: string | null;
  vaccine_group?: string | null;
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
  const [newRuleTargetValue, setNewRuleTargetValue] = useState("");
  const [newRuleMinAge, setNewRuleMinAge] = useState("");
  const [newRuleMaxAge, setNewRuleMaxAge] = useState("");
  const [newRulePriority, setNewRulePriority] = useState("0");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [vaccineGroupSupported, setVaccineGroupSupported] = useState(true);

  // Clears this page's own fetched state on sign-out, whatever triggers
  // it (see top-nav.tsx's doc comment — sign-out now lives solely in
  // TopNav's account menu, and every page's session subscription still
  // picks it up via the standard onAuthStateChange broadcast).
  function resetAfterSignOut() {
    setVaccines([]);
    setPhysicians([]);
    setRules([]);
    setLoadError(null);
    setPhysicianError(null);
    setRuleError(null);
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
      setVaccineGroupSupported(rulesData.vaccineGroupSupported !== false);
      const loadedVaccines: Vaccine[] = [...(vaccinesData.vaccines ?? [])].sort(
        (a: Vaccine, b: Vaccine) => a.name.localeCompare(b.name)
      );
      setVaccines(loadedVaccines);
      setNewRuleTargetValue((current) => current || (loadedVaccines[0] ? `id:${loadedVaccines[0].id}` : ""));
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
    const { vaccineId: targetVaccineId, vaccineGroup: targetVaccineGroup } = parseRuleTargetValue(newRuleTargetValue);
    if (!session || !newRulePhysicianId) return;
    if (!newRuleIsAnyVaccine && !targetVaccineId && !targetVaccineGroup) return;

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
          vaccine_id: newRuleIsAnyVaccine ? null : targetVaccineId,
          vaccine_group: newRuleIsAnyVaccine ? null : targetVaccineGroup,
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
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to manage physicians."
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

  const physicianNameById = new Map(physicians.map((p) => [p.id, p.display_name]));
  const vaccineNameById = new Map(vaccines.map((v) => [v.id, v.name]));

  return (
    <main style={styles.main}>
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
              value={newRuleTargetValue}
              onChange={(e) => setNewRuleTargetValue(e.target.value)}
              disabled={newRuleIsAnyVaccine}
            >
              {availableGroupsFor(vaccines.map((v) => v.name)).map((group) => (
                <optgroup key={group} label={group}>
                  {vaccineGroupSupported && <option value={`group:${group}`}>All {group} vaccines</option>}
                  {vaccines
                    .filter((v) => getVaccineGroup(v.name) === group)
                    .map((v) => (
                      <option key={v.id} value={`id:${v.id}`}>
                        {v.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {!vaccineGroupSupported && (
              <span style={styles.muted}>&quot;All &lt;type&gt; vaccines&quot; rules pending migration.</span>
            )}
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
            disabled={
              ruleBusy ||
              !newRulePhysicianId ||
              (!newRuleIsAnyVaccine && !parseRuleTargetValue(newRuleTargetValue).vaccineId && !parseRuleTargetValue(newRuleTargetValue).vaccineGroup)
            }
          >
            {ruleBusy ? "Adding…" : "Add rule"}
          </button>
        </form>
        {ruleError && <p style={styles.error}>{ruleError}</p>}
        <p style={styles.italic}>
          A specific-vaccine rule always outranks an &quot;All &lt;type&gt; vaccines&quot; rule, which always outranks
          the fallback (&quot;any vaccine&quot;) rule, for the same age — regardless of priority.
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
                  {rule.vaccine_id !== null
                    ? vaccineNameById.get(rule.vaccine_id) ?? "(unknown vaccine)"
                    : rule.vaccine_group
                      ? `All ${rule.vaccine_group} vaccines`
                      : "Any vaccine"}
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
