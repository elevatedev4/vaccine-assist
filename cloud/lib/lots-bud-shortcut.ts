/**
 * Pure date math for the /lots "30d" beyond-use-date shortcut (Will,
 * 2026-09-24 4:24pm verbatim: "for beyond use date, add a 30d little
 * link next to the right side of the box that sets the BUD to 30 days
 * from today"). Kept as its own small, dependency-free module — same
 * posture as lib/lots-autosave.ts and lib/date-mask.ts — so it's
 * directly unit-testable without pulling in React or the page itself.
 *
 * `today` is passed in (rather than read via `new Date()` inside the
 * helper) so this stays pure and easy to test with fixed dates. The
 * caller (app/lots/page.tsx) passes the browser's current local Date,
 * per Will's brief: the shortcut sets the beyond-use date to 30 days
 * from the browser's local calendar day. NOTE this is deliberately
 * different from lib/chicago-date.ts's todayInChicago(), which this same
 * page uses to compute "today" for row missing/expired highlighting —
 * that helper pins "today" to America/Chicago specifically so a staff
 * phone with the wrong local timezone can't shift a day boundary (see
 * its own doc comment). The 30d shortcut is a manual, in-the-moment
 * click by whoever is standing at the keyboard setting a lot's BUD right
 * now, not a server-computed day boundary, so Will's brief calls for the
 * browser's own local date here instead.
 */

/**
 * `today` plus `days` calendar days, as "YYYY-MM-DD" in `today`'s own
 * local time — i.e. computed from `today`'s local
 * getFullYear/getMonth/getDate components, not from UTC or millisecond
 * arithmetic, so month/year rollover (including across a leap day) comes
 * out correct regardless of DST or the machine's timezone offset.
 */
export function plusDaysIso(today: Date, days: number): string {
  const shifted = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const yyyy = String(shifted.getFullYear()).padStart(4, "0");
  const mm = String(shifted.getMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
