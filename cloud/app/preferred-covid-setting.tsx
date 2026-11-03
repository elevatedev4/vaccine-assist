"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PREFERRED_COVID,
  PREFERRED_COVID_ADULT_OPTIONS,
  PREFERRED_COVID_KIDS_OPTIONS,
  type PreferredCovidSetting,
} from "@/lib/preferred-covid";
import { loadPreferredCovid, preferredCovidSaveOutcome } from "@/lib/preferred-covid-client";

/**
 * Data Entry tab: which COVID vaccine the C hotkey picks (V-Q11, Will
 * 2026-10-20: "make it where you can choose the preferred covid vaccine in
 * data entry tab"). One choice for patients 12+, one for children 3-11;
 * each change saves immediately to /api/settings/preferred-covid. Shows
 * the saved value only once it has loaded; a failed load shows an error with
 * Retry and keeps the selects disabled, so the defaults are never mistaken for
 * (or saved over) the real setting.
 *
 * Shared by Data Entry (variant "full"), Lots and Entry values (variant
 * "compact": one labelled block near the page top). All three read and
 * write the same /api/settings/preferred-covid row, so they always agree.
 * `onSettingChange` reports the saved value once loaded and after every
 * change (and the reverted value when a save fails) so a page can badge the
 * matching rows; it is never called with the unconfirmed defaults.
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
  compactBox: { padding: "0.4rem 0.75rem", margin: "0.5rem 0 1rem", background: "#fafafa", border: "1px solid #ddd", borderRadius: 4, fontSize: "13px" },
  compactRow: { display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" as const },
  compactHeading: { margin: 0, fontSize: "13px", fontWeight: 700 },
  compactLabel: { fontWeight: 600 },
  compactSelect: { padding: "2px 4px", fontSize: "13px" },
  compactStatus: { fontSize: "12px", color: "#555" },
  compactError: { fontSize: "12px", color: "#b00020" },
  badge: {
    display: "inline-block",
    marginLeft: "0.4rem",
    padding: "0 5px",
    fontSize: "11px",
    fontWeight: 600,
    lineHeight: 1.5,
    color: "#1a7a34",
    background: "#e6f4ea",
    border: "1px solid #a8d5b5",
    borderRadius: 3,
    verticalAlign: "middle" as const,
  },
} as const;

/** Small "Preferred" tag shown beside the COVID product the C hotkey picks for ages 12+. */
export function PreferredBadge() {
  return (
    <span style={styles.badge} title="The C hotkey picks this vaccine for ages 12+">
      Preferred
    </span>
  );
}

export function PreferredCovidSettingEditor({
  accessToken,
  variant = "full",
  onSettingChange,
}: {
  accessToken: string;
  variant?: "full" | "compact";
  onSettingChange?: (setting: PreferredCovidSetting) => void;
}) {
  const onChangeRef = useRef(onSettingChange);
  onChangeRef.current = onSettingChange;
  const [setting, setSetting] = useState<PreferredCovidSetting>({ ...DEFAULT_PREFERRED_COVID });
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");

  const load = useCallback(async () => {
    setLoadState("loading");
    const result = await loadPreferredCovid(accessToken);
    if (result.ok) {
      setSetting(result.setting);
      setLoadState("loaded");
      onChangeRef.current?.(result.setting);
    } else {
      setLoadState("error");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = loadState === "loaded" && status !== "saving";

  async function save(next: PreferredCovidSetting) {
    const previous = setting;
    setSetting(next);
    onChangeRef.current?.(next);
    setStatus("saving");
    try {
      const response = await fetch("/api/settings/preferred-covid", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(next),
      });
      const body: unknown = await response.json().catch(() => ({}));
      const outcome = preferredCovidSaveOutcome(response.ok, body);
      if (outcome !== "saved") {
        // Nothing was stored (failed, or the settings table isn't set up so
        // the C hotkey keeps using the defaults): show the previous value
        // again and let the page drop any badge for a brand the hotkey
        // won't pick.
        setSetting(previous);
        onChangeRef.current?.(previous);
        setStatus(outcome === "pending" ? "pending" : "error");
        return;
      }
      setStatus("saved");
    } catch {
      setSetting(previous);
      onChangeRef.current?.(previous);
      setStatus("error");
    }
  }

  const statusText =
    status === "saving"
      ? "Saving…"
      : status === "saved"
        ? "Saved."
        : status === "pending"
          ? "Can't be saved yet - the settings table hasn't been set up. The defaults stay in effect."
          : status === "error"
            ? "Couldn't save. Try again."
            : "";

  if (variant === "compact") {
    return (
      <section style={styles.compactBox} aria-labelledby="preferred-covid-heading">
        <div style={styles.compactRow}>
          <h2 id="preferred-covid-heading" style={styles.compactHeading}>Preferred COVID (C hotkey)</h2>
          <label htmlFor="preferred-covid-adult" style={styles.compactLabel}>Ages 12+</label>
          <select
            id="preferred-covid-adult"
            style={styles.compactSelect}
            value={setting.adult}
            disabled={!editable}
            onChange={(e) => void save({ ...setting, adult: e.target.value as PreferredCovidSetting["adult"] })}
          >
            {PREFERRED_COVID_ADULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label htmlFor="preferred-covid-kids" style={styles.compactLabel}>Ages 3-11</label>
          <select
            id="preferred-covid-kids"
            style={styles.compactSelect}
            value={setting.kids}
            disabled={!editable}
            onChange={(e) => void save({ ...setting, kids: e.target.value as PreferredCovidSetting["kids"] })}
          >
            {PREFERRED_COVID_KIDS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {loadState === "loading" && <span style={styles.compactStatus}>Loading…</span>}
          {loadState === "error" && (
            <span role="alert" style={styles.compactError}>
              Couldn&apos;t load the saved setting.{" "}
              <button type="button" onClick={() => void load()}>Retry</button>
            </span>
          )}
          <span role="status" aria-live="polite" style={status === "error" ? styles.compactError : styles.compactStatus}>
            {statusText}
          </span>
        </div>
      </section>
    );
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
          disabled={!editable}
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
          disabled={!editable}
          onChange={(e) => void save({ ...setting, kids: e.target.value as PreferredCovidSetting["kids"] })}
        >
          {PREFERRED_COVID_KIDS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      {loadState === "error" && (
        <div role="alert" style={styles.error}>
          Couldn&apos;t load the saved setting.{" "}
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {loadState === "loading" && <div style={styles.status}>Loading…</div>}
      <div role="status" aria-live="polite" style={status === "error" ? styles.error : styles.status}>
        {status === "saving" && "Saving…"}
        {status === "saved" && "Saved."}
        {status === "pending" && "Can't be saved yet - the settings table hasn't been set up. The defaults stay in effect."}
        {status === "error" && "Couldn't save. Try again."}
      </div>
    </section>
  );
}
