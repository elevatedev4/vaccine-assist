/**
 * Shared constant between app/api/auth/desktop-handoff/route.ts (writes
 * this cookie after validating the desktop's tokens) and
 * app/desktop-handoff-bootstrap.tsx (reads + clears it on the client) —
 * see the route's doc comment for why a cookie is used here at all when
 * this app's real sessions live in localStorage.
 */
export const DESKTOP_HANDOFF_COOKIE_NAME = "va-desktop-handoff";
