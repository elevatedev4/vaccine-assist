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

/**
 * What a PUT /api/settings/preferred-covid response means for the editor:
 * only an ok response without `pending` actually stored the choice. A failed
 * or pending save ("pending" = the settings table isn't set up, nothing was
 * stored) must put the previous value back, so a page never badges a brand
 * the C hotkey won't pick.
 */
export type PreferredCovidSaveOutcome = "saved" | "pending" | "failed";

export function preferredCovidSaveOutcome(responseOk: boolean, body: unknown): PreferredCovidSaveOutcome {
  if (!responseOk) return "failed";
  const pending = !!body && typeof body === "object" && (body as { pending?: unknown }).pending === true;
  return pending ? "pending" : "saved";
}
