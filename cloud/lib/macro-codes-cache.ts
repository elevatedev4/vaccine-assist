/**
 * localStorage cache + shared fetch orchestration for the /macro-codes
 * tab's vaccines+lots payload — Will's verbatim brief (2026-09-13):
 * "Macro codes take way too long to load. It needs to be instant... You
 * should preload the info when the app is first loaded so it will start
 * fast, and then of course make sure that it stays up to date all the
 * time when data changes."
 *
 * Stale-while-revalidate: app/macro-codes/page.tsx renders whatever this
 * module last cached IMMEDIATELY on mount (no "Loading…"), then kicks
 * off a background refetch that replaces it if the server data changed.
 * app/top-nav.tsx (rendered on every route) also calls
 * fetchMacroCodesPayload right after a session appears and writes the
 * result here, so a visit to /macro-codes later — from the same tab or
 * the desktop app's ?embed=1 popup, same origin, same localStorage — is
 * warm before the user ever opens the tab.
 *
 * Kept dependency-free of React so both callers (a page component and a
 * nav component) share the exact same read/write/fetch logic instead of
 * two independent copies drifting apart, and so it's plain-vitest
 * unit-testable the same way lib/macro-codes.ts's
 * readMacroViewMode/writeMacroViewMode are.
 */

/** Minimal shape both callers need — the real API responses carry more
 * fields (see app/macro-codes/page.tsx's VaccineRow/LotRow), but the
 * cache itself only needs to pass whatever shape it was given straight
 * back through, so it stays untyped here rather than importing the
 * page's own row types (which would create a page -> lib -> page-only
 * type dependency for no behavioral benefit). */
export type MacroCodesCachePayload = {
  vaccines: unknown[];
  lots: unknown[];
};

export type MacroCodesCacheEntry = {
  payload: MacroCodesCachePayload;
  /** Date.now() when this payload was fetched successfully. */
  fetchedAt: number;
};

/** Same minimal Storage projection convention as
 * lib/macro-codes.ts's MacroViewModeStorage — a plain object (not the
 * real `Storage` type) so tests can pass an in-memory fake without a
 * DOM. removeItem is included since clearMacroCodesCache uses it (the
 * view-mode storage never needed a remove). */
export type MacroCodesCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const CACHE_KEY_PREFIX = "vaccine-assist:macro-codes-cache:";

/** Every cache entry is keyed by the signed-in user's email — this is a
 * single-shared-login pharmacy tenant today (see README.md), but keying
 * per user means a future second account, or simply someone signing out
 * and a different person signing in on the same browser, never shows
 * the wrong person's cached data. A distinct Supabase project/environment
 * (e.g. this same code running against a different deployment) doesn't
 * need its own key component here — localStorage is already isolated
 * per ORIGIN, so a different deployment is a different origin with its
 * own separate storage automatically. */
function cacheKey(userEmail: string): string {
  return `${CACHE_KEY_PREFIX}${userEmail.trim().toLowerCase()}`;
}

function isValidPayload(value: unknown): value is MacroCodesCachePayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.vaccines) && Array.isArray(candidate.lots);
}

/** Wraps `window.localStorage` in the same try/catch-to-null convention
 * as lib/macro-codes.ts's page-local getViewModeStorage, factored out
 * here so both app/macro-codes/page.tsx and app/top-nav.tsx share one
 * copy instead of two. */
export function getMacroCodesCacheStorage(): MacroCodesCacheStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the cached payload for `userEmail`, or null when there is none
 * or it fails to parse/validate (a corrupt or old-shape entry is treated
 * exactly like a cache miss, never thrown). */
export function readMacroCodesCache(
  storage: MacroCodesCacheStorage | null | undefined,
  userEmail: string | null | undefined
): MacroCodesCacheEntry | null {
  if (!storage || !userEmail) return null;
  try {
    const raw = storage.getItem(cacheKey(userEmail));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MacroCodesCacheEntry> | null;
    if (!parsed || typeof parsed.fetchedAt !== "number" || !isValidPayload(parsed.payload)) {
      return null;
    }
    return { payload: parsed.payload, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

/** Writes/replaces the cached payload for `userEmail`. Best-effort —
 * localStorage being full or unavailable (private browsing) only means
 * the NEXT visit falls back to a real fetch before showing anything,
 * same as today; it never blocks or fails the caller's own render. */
export function writeMacroCodesCache(
  storage: MacroCodesCacheStorage | null | undefined,
  userEmail: string | null | undefined,
  payload: MacroCodesCachePayload
): void {
  if (!storage || !userEmail) return;
  try {
    const entry: MacroCodesCacheEntry = { payload, fetchedAt: Date.now() };
    storage.setItem(cacheKey(userEmail), JSON.stringify(entry));
  } catch {
    // best-effort, see doc comment above
  }
}

/** Removes the cached payload for `userEmail` — used on sign-out so the
 * next sign-in (same browser, possibly a different person on this
 * shared-login tenant) never renders a stale cache from someone else
 * before its own first real fetch completes. */
export function clearMacroCodesCache(
  storage: MacroCodesCacheStorage | null | undefined,
  userEmail: string | null | undefined
): void {
  if (!storage || !userEmail) return;
  try {
    storage.removeItem(cacheKey(userEmail));
  } catch {
    // best-effort, see writeMacroCodesCache's doc comment
  }
}

/** A cached entry older than this is still shown (better than a blank
 * "Loading…" or last-known-good data disappearing) but reported stale by
 * isMacroCodesCacheStale, so a caller can surface a "could not refresh"
 * style note instead of trusting an old cache forever. Well above the
 * page's own ~60s background revalidation interval — under a normal
 * working network this never trips; it only fires when refreshes have
 * been failing for a while (offline, signed-out token, server error). */
export const MACRO_CODES_CACHE_STALE_MS = 5 * 60 * 1000;

export function isMacroCodesCacheStale(entry: MacroCodesCacheEntry, now: number = Date.now()): boolean {
  return now - entry.fetchedAt > MACRO_CODES_CACHE_STALE_MS;
}

export type MacroCodesFetchResult =
  | { ok: true; payload: MacroCodesCachePayload }
  | { ok: false; unauthorized: boolean; message: string };

/** The one real network fetch for this tab's data — GET /api/vaccines +
 * GET /api/lots in parallel, same two requests app/macro-codes/page.tsx
 * always made. Shared by the page's own initial/background loads AND
 * app/top-nav.tsx's post-login prefetch so there is exactly one place
 * that knows the request shape, instead of the nav and the page
 * building it twice and drifting apart. Never throws — a thrown fetch
 * (offline, aborted) is reported the same way as a non-2xx response.
 * `unauthorized` is surfaced separately from a generic failure so a
 * caller can tell "the token is dead, don't trust anything from this
 * response" apart from "the network hiccuped, the cache is still fine"
 * (app/macro-codes/page.tsx's brief: "a 401/expired token never renders
 * stale data silently"). */
export async function fetchMacroCodesPayload(accessToken: string): Promise<MacroCodesFetchResult> {
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [vaccinesRes, lotsRes] = await Promise.all([
      fetch("/api/vaccines?includeInactive=true", { headers }),
      fetch("/api/lots", { headers }),
    ]);
    const [vaccinesData, lotsData] = await Promise.all([
      vaccinesRes.json().catch(() => ({})),
      lotsRes.json().catch(() => ({})),
    ]);

    if (!vaccinesRes.ok) {
      return {
        ok: false,
        unauthorized: vaccinesRes.status === 401,
        message: vaccinesData?.error ?? "Could not load vaccines.",
      };
    }
    if (!lotsRes.ok) {
      return {
        ok: false,
        unauthorized: lotsRes.status === 401,
        message: lotsData?.error ?? "Could not load lots.",
      };
    }

    return {
      ok: true,
      payload: { vaccines: vaccinesData.vaccines ?? [], lots: lotsData.lots ?? [] },
    };
  } catch (err) {
    return { ok: false, unauthorized: false, message: err instanceof Error ? err.message : "Could not load macro codes." };
  }
}
