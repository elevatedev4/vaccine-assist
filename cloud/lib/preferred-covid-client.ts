import { normalizePreferredCovid, type PreferredCovidSetting } from "@/lib/preferred-covid";

/**
 * Browser-side load of the saved preferred-COVID setting for the Data Entry
 * editor. Distinguishes "loaded" from "could not load" - the editor must not
 * show the defaults as if they were the saved choice after a failed GET (a
 * later change would then overwrite a setting the user never saw). Pure
 * (fetch injected) so it is unit tested without React/DOM.
 */
export type PreferredCovidLoadResult = { ok: true; setting: PreferredCovidSetting } | { ok: false };

export async function loadPreferredCovid(
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<PreferredCovidLoadResult> {
  try {
    const response = await fetchImpl("/api/settings/preferred-covid", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return { ok: false };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return { ok: false };
    return { ok: true, setting: normalizePreferredCovid(body) };
  } catch {
    return { ok: false };
  }
}
