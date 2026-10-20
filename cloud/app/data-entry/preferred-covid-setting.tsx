"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_PREFERRED_COVID,
  PREFERRED_COVID_ADULT_OPTIONS,
  PREFERRED_COVID_KIDS_OPTIONS,
  normalizePreferredCovid,
  type PreferredCovidSetting,
} from "@/lib/preferred-covid";

/**
 * Data Entry tab: which COVID vaccine the C hotkey picks (V-Q11, Will
 * 2026-10-20: "make it where you can choose the preferred covid vaccine in
 * data entry tab"). One choice for patients 12+, one for children 3-11;
 * each change saves immediately to /api/settings/preferred-covid. Shows
 * the defaults (Pfizer 12+, Moderna 3-11) until a saved value loads.
 */

type SaveStatus = "idle" | "saving" | "saved" | "error" | "pending";

const styles = {
  box: { padding: "1rem 1.25rem", marginTop: "1.5rem", background: "#fafafa", border: "1px solid #ddd", borderRadius: 4 },
  heading: { margin: "0 0 0.25rem", fontSize: "1.05rem" },
  muted: { color: "#555", fontSize: "0.875rem", margin: "0 0 0.75rem" },
  row: { display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap" as const },
  label: { fontWeight: 600, minWidth: "7rem" },
  select: { padding: "0.35rem 0.5rem", fontSize: "0.95rem" },
  status: { fontSize: "0.85rem", color: "#555", minHeight: "1.2rem" },
  error: { fontSize: "0.85rem", color: "#b00020", minHeight: "1.2rem" },
} as const;

export function PreferredCovidSettingEditor({ accessToken }: { accessToken: string }) {
  const [setting, setSetting] = useState<PreferredCovidSetting>({ ...DEFAULT_PREFERRED_COVID });
  const [status, setStatus] = useState<SaveStatus>("idle");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/settings/preferred-covid", { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled) setSetting(normalizePreferredCovid(body));
      } catch {
        // Keep showing the defaults.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  async function save(next: PreferredCovidSetting) {
    const previous = setting;
    setSetting(next);
    setStatus("saving");
    try {
      const response = await fetch("/api/settings/preferred-covid", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(next),
      });
      const body: { pending?: boolean } = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSetting(previous);
        setStatus("error");
        return;
      }
      setStatus(body.pending ? "pending" : "saved");
    } catch {
      setSetting(previous);
      setStatus("error");
    }
  }

  return (
    <section style={styles.box} aria-labelledby="preferred-covid-heading">
      <h2 id="preferred-covid-heading" style={styles.heading}>Preferred COVID vaccine</h2>
      <p style={styles.muted}>The C hotkey in the desktop macro list picks this vaccine for the patient&apos;s age.</p>
      <div style={styles.row}>
        <label htmlFor="preferred-covid-adult" style={styles.label}>Ages 12+</label>
        <select
          id="preferred-covid-adult"
          style={styles.select}
          value={setting.adult}
          disabled={status === "saving"}
          onChange={(e) => void save({ ...setting, adult: e.target.value as PreferredCovidSetting["adult"] })}
        >
          {PREFERRED_COVID_ADULT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div style={styles.row}>
        <label htmlFor="preferred-covid-kids" style={styles.label}>Ages 3-11</label>
        <select
          id="preferred-covid-kids"
          style={styles.select}
          value={setting.kids}
          disabled={status === "saving"}
          onChange={(e) => void save({ ...setting, kids: e.target.value as PreferredCovidSetting["kids"] })}
        >
          {PREFERRED_COVID_KIDS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div role="status" aria-live="polite" style={status === "error" ? styles.error : styles.status}>
        {status === "saving" && "Saving…"}
        {status === "saved" && "Saved."}
        {status === "pending" && "Can't be saved yet - the settings table hasn't been set up. The defaults stay in effect."}
        {status === "error" && "Couldn't save. Try again."}
      </div>
    </section>
  );
}
