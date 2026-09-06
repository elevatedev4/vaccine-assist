/**
 * This app treats "today" / a calendar day as the pharmacy's local day in
 * America/Chicago — a single fixed IANA zone, not whatever zone the server
 * happens to run in (Vercel functions have no fixed region/timezone) or
 * whatever zone a browser's `Date` methods report (a staff phone set to
 * the wrong local timezone would otherwise shift every day boundary).
 *
 * Same fixed-timezone approach as clarify's localDayFloor: pin the
 * business day to one zone so "today" and range boundaries are computed
 * the same way everywhere this app runs, server or client.
 *
 * ASSUMPTION, documented here because it's load-bearing: Orchards Drug
 * operates in Central time, and its Acuity account is assumed to be
 * configured to America/Chicago (or an equivalent Central-time zone) too
 * — see fetchAppointmentsForRange in lib/acuity-client.ts, which derives
 * each appointment's calendar day from Acuity's `datetime` field (which
 * carries its own UTC offset) by re-rendering that instant in
 * America/Chicago, rather than trusting Acuity's account-zone offset to
 * already equal Chicago's. If this pharmacy ever adds a location in
 * another time zone, this constant needs to become per-location config.
 */
const CHICAGO_TZ = "America/Chicago";

// en-CA formats as YYYY-MM-DD directly — avoids a manual part-reassembly
// step (Intl.DateTimeFormat's parts order otherwise varies by locale).
const chicagoDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHICAGO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" — the America/Chicago calendar day containing `instant`. */
export function chicagoDateString(instant: Date): string {
  return chicagoDayFormatter.format(instant);
}

/** Today's date, "YYYY-MM-DD", as of this instant in America/Chicago. */
export function todayInChicago(): string {
  return chicagoDateString(new Date());
}

// hourCycle: "h23" (rather than plain hour12: false) is deliberate — some
// environments render hour12:false as "24" for midnight under an "en-US"
// -style locale (a documented Intl quirk), which would make chicagoHour
// return 24 instead of 0 for a midnight appointment. "h23" pins the output
// to the conventional 0-23 range with no such wraparound.
const chicagoHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CHICAGO_TZ,
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * 0-23 — the America/Chicago hour-of-day containing `instant` (V-T-hourly
 * -table, Will 2026-09-05: hourly appointment breakdown). Same fixed
 * -timezone rationale as chicagoDateString above — this is used to bucket
 * an appointment's `datetime` (which carries its own UTC offset) into a
 * Chicago wall-clock hour, not whatever hour a server or browser's local
 * zone would compute.
 */
export function chicagoHour(instant: Date): number {
  return Number(chicagoHourFormatter.format(instant));
}

/**
 * `dateStr` ("YYYY-MM-DD") + `days`, still "YYYY-MM-DD". Pure calendar-date
 * arithmetic — never touches a timezone or DST, since it operates on the
 * date components directly (noon UTC is just a safe anchor to avoid any
 * day-rounding surprise when re-serializing).
 */
export function addDaysToChicagoDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The inclusive [today, today+days] range of Chicago calendar days, e.g.
 * `chicagoDayRange(7)` for the dashboard's "next 7 days" view returns 8
 * entries (today plus the next 7).
 */
export function chicagoDayRange(days: number): string[] {
  const today = todayInChicago();
  const result: string[] = [];
  for (let i = 0; i <= days; i++) {
    result.push(addDaysToChicagoDate(today, i));
  }
  return result;
}
