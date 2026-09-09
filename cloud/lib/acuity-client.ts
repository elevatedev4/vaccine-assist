import "server-only";
import { addDaysToChicagoDate, chicagoDateString, chicagoHour } from "@/lib/chicago-date";

/**
 * Minimal server-side Acuity Scheduling API client. Acuity uses HTTP
 * Basic auth: username = Acuity User ID, password = Acuity API key
 * (https://developers.acuityscheduling.com/reference/authentication).
 *
 * Only ever call this from server code (route handlers) — it exists so
 * the "Test connection" button in the settings UI and the phase-2 poll
 * route (app/api/acuity/poll/route.ts) can round-trip against the real
 * Acuity API without the credentials ever reaching the browser.
 */

const ACUITY_ME_URL = "https://acuityscheduling.com/api/v1/me";
const ACUITY_APPOINTMENTS_URL = "https://acuityscheduling.com/api/v1/appointments";
const ACUITY_APPOINTMENT_TYPES_URL = "https://acuityscheduling.com/api/v1/appointment-types";

function basicAuthHeader(userId: string, apiKey: string): string {
  return `Basic ${Buffer.from(`${userId}:${apiKey}`).toString("base64")}`;
}

export type AcuityConnectionTestResult = {
  ok: boolean;
  message: string;
};

export async function testAcuityConnection(
  userId: string,
  apiKey: string
): Promise<AcuityConnectionTestResult> {
  if (!userId || !apiKey) {
    return { ok: false, message: "Both the User ID and API key are required." };
  }

  let response: Response;
  try {
    response = await fetch(ACUITY_ME_URL, {
      headers: { Authorization: basicAuthHeader(userId, apiKey) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Never include the key in this message — only network-level detail.
    return {
      ok: false,
      message: err instanceof Error ? `Could not reach Acuity: ${err.message}` : "Could not reach Acuity.",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: "Acuity rejected these credentials. Double-check the User ID and API key.",
    };
  }

  if (!response.ok) {
    return { ok: false, message: `Acuity returned an unexpected status (${response.status}).` };
  }

  const data = await response.json().catch(() => null);
  const name =
    data && typeof data === "object" && "name" in data && typeof (data as { name?: unknown }).name === "string"
      ? (data as { name: string }).name
      : null;

  return { ok: true, message: name ? `Connected as ${name}.` : "Connection succeeded." };
}

/**
 * Thrown by the fetch* functions below on any network/auth/parse failure.
 * The message is safe to surface to an authenticated caller (route
 * handler) — it never includes the API key.
 */
export class AcuityApiError extends Error {}

export type AcuityAppointmentType = { id: number; name: string };

/**
 * Fetches the account's appointment types (GET /appointment-types) and
 * returns only id + name — the fields this app ever needs to label a
 * count. See https://developers.acuityscheduling.com/reference for the
 * full (unused) field list: description, price, duration, etc.
 */
export async function fetchAppointmentTypes(
  userId: string,
  apiKey: string
): Promise<AcuityAppointmentType[]> {
  let response: Response;
  try {
    response = await fetch(ACUITY_APPOINTMENT_TYPES_URL, {
      headers: { Authorization: basicAuthHeader(userId, apiKey) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new AcuityApiError(
      err instanceof Error ? `Could not reach Acuity: ${err.message}` : "Could not reach Acuity."
    );
  }

  if (!response.ok) {
    throw new AcuityApiError(`Acuity returned an unexpected status (${response.status}) for appointment types.`);
  }

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new AcuityApiError("Acuity returned an unexpected appointment-types response.");
  }

  return data
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      id: Number(entry.id),
      name: typeof entry.name === "string" ? entry.name : `Type ${String(entry.id)}`,
    }))
    .filter((entry) => Number.isFinite(entry.id));
}

/**
 * The ONLY shape this module reads off a raw Acuity appointment. This is
 * the PHI-stripping boundary: fetchAppointmentsForRange below parses the
 * Acuity response and immediately projects each entry down to just these
 * two fields before returning — firstName/lastName/email/phone/notes/
 * forms/etc from the raw API response are discarded in that same map
 * step and never returned from this function, so no code downstream of
 * it (aggregation, caching, the API response, the dashboard) can leak
 * patient data even by accident.
 */
export type CountableAppointment = {
  /**
   * "YYYY-MM-DD" — the America/Chicago calendar day the appointment falls
   * on, derived from Acuity's `datetime` field (ISO 8601 WITH the
   * business's UTC offset, e.g. "2026-08-16T22:00:00-0500") via
   * chicagoDateString. Deliberately NOT Acuity's own `date` field: that
   * field is a human-readable string like "August 16, 2026" (see the
   * developers.acuityscheduling.com sample response), not "YYYY-MM-DD" as
   * an earlier version of this code assumed — using it directly meant no
   * fetched appointment's date ever matched a "YYYY-MM-DD" range/day key
   * downstream, so nothing ever showed up on the dashboard for ANY day,
   * not just ones near a UTC boundary. Deriving from `datetime` instead
   * also fixes the related bug where a naive UTC-day read of `datetime`
   * put a late-evening Central appointment on the wrong (next) day.
   */
  date: string;
  appointmentTypeId: number;
  /**
   * PHI boundary, extension of the CountableAppointment doc comment above:
   * this is the ONLY other field this module ever reads off a raw
   * appointment's `forms` array (see extractVaccineNamesFromForms) — the
   * exact vaccine name(s) the patient is getting, per V-T-something
   * (Will, 2026-08-19): "I want to see the exact vaccines ... COVID-Pfizer,
   * COVID-Moderna, Flu, RSV, etc." rather than the generic Acuity
   * appointment-type name. Every other form question/answer (insurance,
   * consent, symptoms, etc.) on that same form is discarded and never
   * touches this type or anything downstream of it. Empty when no form
   * field matched isVaccineFormFieldName — callers fall back to the
   * appointment type's name in that case (see aggregateAppointmentCounts).
   */
  vaccineNames: string[];
  /**
   * PHI boundary, further extension (V-T-schedule-table, Will 2026-09-04:
   * split the COVID column by brand preference and age band). This is a
   * BUCKETED value only — "pfizer" | "moderna" | "any" — derived from the
   * intake-form field matched by isCovidBrandFormFieldName (see
   * deriveCovidBrand). The raw form answer string is read only inside
   * deriveCovidBrand and is discarded the instant it's bucketed; it never
   * becomes part of this type or anything returned from this module.
   */
  covidBrand: CovidBrand;
  /**
   * PHI boundary, same rationale as covidBrand above — a BUCKETED value
   * only: "3-11" | "12+" | "unknown". Derived from the intake-form field
   * matched by isAgeFormFieldName (see deriveAgeInYears + bucketCovidAge),
   * which reads either a plain numeric age or a date of birth. CRITICAL:
   * the raw age number and the raw DOB string are both read ONLY inside
   * deriveAgeInYears/computeAgeFromDob and are discarded the instant
   * they're bucketed — neither the exact age nor the DOB ever becomes
   * part of this type, an API response, a cache row, or a log line.
   */
  covidAgeBucket: CovidAgeBucket;
  /**
   * PHI boundary, extension of covidAgeBucket above (V-T-schedule-table
   * ROUND 2, Will 2026-09-04/05: split the Flu column by age too — "3-64"
   * | "65+" | "unknown"). Derived from the SAME age-question
   * infrastructure as covidAgeBucket — extractFormFieldAnswer/
   * isAgeFormFieldName, then computeAgeFromDob for a DOB answer — via
   * deriveAgeInYears, not a second/duplicate age-field matcher. The raw
   * age/DOB is discarded the instant it's bucketed, same rule as
   * covidAgeBucket: it never becomes part of this type, an API response,
   * a cache row, or a log line.
   */
  fluAgeBucket: FluAgeBucket;
  /**
   * PHI boundary, extension of the CountableAppointment doc comment above
   * (V-T-hourly-table, Will 2026-09-05: "hourly breakdown of how many
   * vaccines are scheduled by the hour"). 0-23, derived from the SAME
   * `datetime` instant as `date` (via lib/chicago-date.ts's chicagoHour) —
   * one Chicago wall-clock hour bucket, nothing finer. The raw `datetime`
   * string itself is discarded the instant both `date` and `hourOfDay` are
   * derived from it (see acuityDatetimeToChicagoHour below) — like every
   * other field here, only the bucketed value ever leaves this module.
   */
  hourOfDay: number;
  /**
   * PHI boundary, extension of the CountableAppointment doc comment above
   * (V-T-poc-testing, Will 2026-09-08: "Add a point of care testing
   * appointment table too that shows daily totals for each type of test
   * that is scheduled"). The exact test(s) selected on a point-of-care
   * testing appointment — mirrors vaccineNames' own mechanism exactly:
   * derived by extractTestNamesFromForms (isTestFormFieldName) from the
   * SAME `forms` array vaccineNames reads, with a fallback (only when no
   * form field matches) to parsing the appointment TYPE's own name for a
   * parenthetical test list — see extractTestNamesFromForms's doc comment
   * for the live-probe evidence (2026-09-08) behind both paths. Empty when
   * neither path finds anything. Every other field on `forms`/the raw
   * entry is still discarded exactly as before — this is one more
   * narrowly-scoped read, not a loosening of the boundary.
   */
  testNames: string[];
  /**
   * PHI boundary, extension of the CountableAppointment doc comment above
   * (V-T-booking-activity, Will 2026-09-05/07: "# vaccines BOOKED per day
   * — the day the booking was MADE, not the appointment date — for the
   * last 28 days, so I can track marketing"). "YYYY-MM-DD" — the
   * America/Chicago calendar day the booking was CREATED on, derived from
   * Acuity's `datetimeCreated` field the exact same way `date` is derived
   * from `datetime` (see acuityDatetimeToChicagoDate). Acuity's
   * appointments endpoint returns `datetimeCreated` alongside `datetime`
   * on every real appointment (verified against
   * developers.acuityscheduling.com's sample response) — same ISO 8601 +
   * UTC-offset shape, just timestamping when the booking was made rather
   * than when the visit happens. "" on anything unparseable/missing, same
   * fail-soft sentinel as `date` — a caller aggregating by createdDate
   * (lib/acuity-booking-activity.ts) filters these out via its own
   * date-range check rather than this module dropping them outright,
   * since an entry with a bad createdDate is still perfectly valid for
   * every OTHER purpose (the main day-by-day table keys off `date`, never
   * `createdDate`).
   */
  createdDate: string;
};

/** Brand-preference bucket for a COVID appointment — see covidBrand above. */
export type CovidBrand = "pfizer" | "moderna" | "any";

/**
 * Age bucket for a COVID appointment — see covidAgeBucket above. Revised
 * (V-T-schedule-table ROUND 2, Will 2026-09-05, superseding the original
 * 3-11/12+ split same-day): brands now split at 65 too, matching the
 * fixed columns his mockup lists (Pfizer 12-64/65+; Moderna and Any
 * 3-11/12-64/65+) — see FIXED_COVID_COMBO_IDS in lib/appointment-table.ts
 * for which (brand, bucket) pairs are actually fixed columns vs. render
 * only when nonzero.
 */
export type CovidAgeBucket = "3-11" | "12-64" | "65+" | "unknown";

/**
 * Age bucket for a Flu appointment — see fluAgeBucket above. Revised
 * (V-T-schedule-table ROUND 2, Will 2026-09-05): "3-64" replaces the
 * original "<65" label — both COVID and Flu now share the same young-end
 * cutoff (age 3), so ages 0-2 bucket to "unknown" for Flu too, same as
 * COVID's existing <3 -> unknown rule (see bucketCovidAge/bucketFluAge).
 */
export type FluAgeBucket = "3-64" | "65+" | "unknown";

export type AppointmentRangeResult = {
  appointments: CountableAppointment[];
  /**
   * MSG-897 (Will: "the app must be reliable regardless of volume" —
   * "warning stays" isn't the end state when a deterministic workaround
   * exists). Acuity's API documents no offset/pagination param (verified
   * live against developers.acuityscheduling.com/reference/get-appointments,
   * 2026-09-08 — `max` is the only result-limiting param), but it DOES
   * accept `minDate`/`maxDate`, so fetchAppointmentsForRange below now
   * pages by recursively halving the requested date window whenever a
   * request comes back saturated (exactly `max` rows) — see that
   * function's doc comment for the full algorithm. This flag now means
   * something narrower than "this one request hit the cap": it's true
   * ONLY in the two residual cases pagination can't resolve —
   *   1. a SINGLE calendar day alone still returned exactly `max` rows
   *      (the recursion floor — can't split a day any further), or
   *   2. REQUESTS_PER_RANGE_BUDGET was exhausted before every sub-window
   *      could be confirmed complete (a defensive ceiling, logged when it
   *      fires).
   * In every other case — including a range that used to trip this flag
   * under the old single-request behavior — pagination now recovers the
   * complete count and this is false. Callers (the dashboard's "100+
   * appointments... may be incomplete" warnings) don't need to change:
   * they already just render off this boolean, and it's simply true far
   * less often now.
   */
  possiblyTruncated: boolean;
};

/**
 * V-T23 (Will, verbatim: "A single day can absolutely have more than 100
 * appointments. You'll have to figure out a solution that works for
 * that."). Live-probed against the real Acuity API (2026-09-08, read-only
 * GETs against the production account — counts only, no patient data):
 * Acuity's `max` param is NOT actually hard-capped at 100 despite this
 * account's own /reference docs page only documenting the parameter, not
 * a ceiling — a `max=500` request over a 455-day range returned 352 rows
 * (the account's true total for that window; raising to `max=1000` or even
 * `max=100000` returned the identical 352, confirming 352 is the complete
 * count, not a second cap) in ~330-1045ms. That makes "bigger max" the
 * first strategy in the brief's preference order (bigger max -> datetime
 * sub-windows -> per-type/per-calendar sub-queries) the one that ships:
 * raised from 100 to 1000, comfortably above any plausible single-day
 * volume for this single-pharmacy account (the busiest 60-day window
 * probed came back at 120 total appointments) while still bounding one
 * request's worst-case payload/latency. The recursive date-halving in
 * fetchAppointmentsForRange below is UNCHANGED and stays as the safety
 * net for the (now far less likely) case a single day still saturates
 * even at this raised cap — see that function's doc comment.
 *
 * (Datetime sub-windows were separately confirmed to work too —
 * minDate/maxDate accept a full "YYYY-MM-DDTHH:MM:SS" value and correctly
 * narrow the result — but aren't needed now that strategy 1 resolves the
 * problem outright; per-appointment-type/per-calendar sub-queries were
 * confirmed available (GET /calendars; both calendarID and
 * appointmentTypeID filter /appointments) but likewise unneeded.)
 *
 * Exported (like REQUESTS_PER_RANGE_BUDGET below) so tests can assert
 * against the real cap rather than a hardcoded duplicate of this number.
 */
export const ACUITY_APPOINTMENTS_MAX = 1000;

/**
 * Ceiling on how many Acuity requests ONE top-level fetchAppointmentsForRange
 * call may issue while recursively halving a saturated window (see that
 * function's doc comment) — a defensive stop, not a number Will's real
 * volume should ever approach: at 2 requests per split level, this affords
 * roughly log2(24) ≈ 4-5 levels of halving before bailing, and a single
 * calendar day hitting the cap on its own (the recursion floor) is already
 * "beyond plausible load" per Will's own framing of this feature. Exported
 * so tests/acuity-client.test.ts can assert against the real cap rather
 * than a hardcoded duplicate of this number (same pattern as
 * AFTER_TODAY_FETCH_CONCURRENCY in lib/acuity-future-summary.ts).
 */
export const REQUESTS_PER_RANGE_BUDGET = 24;

/**
 * "" on anything not parseable — callers filter empty-date entries out,
 * same fail-soft-and-drop behavior as the previous appointmentTypeID
 * NaN check. See CountableAppointment for why this reads `datetime`
 * (ISO 8601 + offset) rather than Acuity's own `date` field.
 */
function acuityDatetimeToChicagoDate(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return chicagoDateString(parsed);
}

/**
 * -1 (an out-of-range sentinel, never a real hour) on anything unparseable
 * — same fail-soft shape as acuityDatetimeToChicagoDate's "" sentinel
 * above. Harmless in practice: fetchAppointmentsForRange's final filter
 * already drops any entry whose `date` came back "" (unparseable
 * `datetime`), and `date`/`hourOfDay` are always derived from that same
 * `datetime` value, so a surviving entry's `hourOfDay` is always a real
 * 0-23 value.
 */
function acuityDatetimeToChicagoHour(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return -1;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return -1;
  return chicagoHour(parsed);
}

/**
 * Matches an Acuity intake-form field's `name` against a "does this look
 * like the vaccine-selection question" heuristic: case-insensitive
 * substring match on "vaccine" (e.g. "Which vaccine(s) are you
 * receiving?"). Deliberately a small, separately-exported, separately-
 * tested function — Will's real Acuity form field label hasn't been
 * confirmed yet (no live account to inspect while building this), so if
 * this heuristic turns out wrong once he can test on Windows, fixing it
 * is a one-function change rather than a hunt through fetch/aggregation
 * logic. See the residual-risk note in the poll route's doc comment.
 */
export function isVaccineFormFieldName(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().includes("vaccine");
}

/**
 * Matches an Acuity intake-form field's `name` against a "does this look
 * like the COVID brand-preference question" heuristic (V-T-schedule-table,
 * Will 2026-09-04): case-insensitive substring match on "brand", or a
 * field that mentions both "pfizer" and "moderna" (e.g. "Pfizer or
 * Moderna?"). Same rationale as isVaccineFormFieldName above — Will's real
 * form label hasn't been confirmed yet, so this is a small, separately-
 * exported, separately-tested heuristic that can be fixed in one place if
 * it turns out wrong.
 */
export function isCovidBrandFormFieldName(name: string): boolean {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  return lower.includes("brand") || (lower.includes("pfizer") && lower.includes("moderna"));
}

/**
 * Matches an Acuity intake-form field's `name` against a "does this look
 * like the patient-age question" heuristic (V-T-schedule-table). Matches
 * "date of birth"/"dob"/"birth", or "age" as a whole word (\bage\b) —
 * deliberately NOT a bare substring match, since "age" is a substring of
 * common unrelated words like "average" or "package" that would otherwise
 * false-positive.
 */
export function isAgeFormFieldName(name: string): boolean {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  if (lower.includes("date of birth") || lower.includes("dob") || lower.includes("birth")) return true;
  return /\bage\b/.test(lower);
}

/**
 * PHI boundary: this function must only ever be called with
 * `entry.forms` — never the full raw appointment entry — so it has no
 * way to read name/email/phone/notes even by accident; those never
 * appear on `forms`.
 *
 * Finds the first form field whose name matches isVaccineFormFieldName
 * and splits its answer into individual vaccine names. Acuity represents
 * a multi-select/checkbox answer as a comma-, pipe-, or newline-
 * separated string in `value` — split on any of those so a single
 * appointment can count toward multiple vaccine columns (e.g. a patient
 * getting both Flu and COVID-Pfizer in one visit). Trims whitespace and
 * drops empty entries. Returns [] if no matching field is found or its
 * value is blank — callers fall back to the appointment type's name.
 */
function extractVaccineNamesFromForms(forms: unknown): string[] {
  if (!Array.isArray(forms)) return [];

  for (const form of forms) {
    if (typeof form !== "object" || form === null) continue;
    const values = (form as Record<string, unknown>).values;
    if (!Array.isArray(values)) continue;

    for (const field of values) {
      if (typeof field !== "object" || field === null) continue;
      const fieldName = (field as Record<string, unknown>).name;
      const fieldValue = (field as Record<string, unknown>).value;
      if (typeof fieldName !== "string" || !isVaccineFormFieldName(fieldName)) continue;
      if (typeof fieldValue !== "string") continue;

      const names = fieldValue
        .split(/[,|\n]/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (names.length > 0) return names;
    }
  }

  return [];
}

/**
 * PHI boundary, same rule as extractVaccineNamesFromForms: must only ever
 * be called with `entry.forms`. Finds the first form field whose name
 * matches `matcher` and returns its raw trimmed answer string, or null if
 * no matching field is found or its value is blank. Deliberately generic
 * (unlike extractVaccineNamesFromForms, it doesn't split multi-value
 * answers) — brand/age are single-answer questions. Callers
 * (deriveCovidBrand, deriveAgeInYears) MUST bucket this raw string
 * immediately and never let it escape further — see CountableAppointment's
 * covidBrand/covidAgeBucket/fluAgeBucket doc comments.
 */
function extractFormFieldAnswer(forms: unknown, matcher: (name: string) => boolean): string | null {
  if (!Array.isArray(forms)) return null;

  for (const form of forms) {
    if (typeof form !== "object" || form === null) continue;
    const values = (form as Record<string, unknown>).values;
    if (!Array.isArray(values)) continue;

    for (const field of values) {
      if (typeof field !== "object" || field === null) continue;
      const fieldName = (field as Record<string, unknown>).name;
      const fieldValue = (field as Record<string, unknown>).value;
      if (typeof fieldName !== "string" || !matcher(fieldName)) continue;
      if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) continue;
      return fieldValue.trim();
    }
  }

  return null;
}

/**
 * PHI BOUNDARY, tightened per security review (2026-09-08, REQUEST_CHANGES
 * — blocking): a bare case-insensitive substring match on "test" would
 * also match a genuine SCREENING question, e.g. "Have you had a positive
 * COVID test recently?" or "Any test results we should know about?" —
 * both real intake-form questions whose free-text ANSWER could be actual
 * patient health information, not a test-type selection. That answer
 * would have flowed straight through extractTestNamesFromForms below into
 * testNames -> the point-of-care test table -> a `tests_` cache row and
 * onto the rendered page as a column header, i.e. a genuine PHI leak.
 *
 * Fixed to an ALLOWLIST match against the one field name actually
 * observed live (2026-09-08 probe, production account, appointment type
 * "Test appointment (Flu, COVID, Strep)"): the real field is exactly
 * "Select tests:". Normalizes `name` (lowercase, trim, strip a trailing
 * ":") and requires the result to be EXACTLY TEST_FIELD_EXACT_NAME or to
 * START WITH TEST_FIELD_NAME_PREFIX (covers a plausible singular-vs-plural
 * rename, "Select test:", without falling back to a bare substring match)
 * — both small, exported-in-spirit constants right below so a future
 * rename on Will's Acuity account is a one-line change here, not a
 * loosened heuristic. A screening question like the ones above normalizes
 * to e.g. "have you had a positive covid test recently" — neither equals
 * nor starts with the allowlisted prefix, so it's correctly rejected.
 *
 * V-T27 follow-up (Will, 2026-09-09 verbatim: "Make sure the test
 * appointment data is coming through (which test they want to receive
 * from the intake questions)" — the Tests column was showing "COVID" for
 * only SOME rows): a real Acuity form can also phrase the same selection
 * as a QUESTION rather than a "Select tests:" label — e.g. "Which test
 * would you like?" — which the allowlist above didn't match at all, so
 * that appointment's testNames came back empty.
 *
 * SECURITY REVIEW FOLLOW-UP (2026-09-09, REQUEST_CHANGES — blocking,
 * BLOCKED feat/explorer-group-tables): the first cut of this question-
 * shape match (a bare "starts with which/what AND mentions test(s)"
 * regex) was too broad — it also matched genuine SCREENING/history
 * questions phrased as a question, e.g. "What test result did you have
 * last time?" or "Which tests are you currently taking (medications)?",
 * both of which are backward-looking and could carry real patient health
 * information in their free-text answer. Fixed by isTestSelectionQuestion
 * below to a two-sided check on the normalized name: it must contain at
 * least one FORWARD-LOOKING selection phrase
 * (TEST_SELECTION_QUESTION_REQUIRED_PHRASES — "would you like", "to
 * receive", "select", "choose", etc.) AND must NOT contain any
 * BACKWARD-LOOKING/screening word (TEST_SELECTION_QUESTION_EXCLUDED_WORDS
 * — "result", "positive", "taking", "history", "symptom", etc.), on top of
 * the original which/what + test(s) gate. "Which test would you like?"
 * passes (has "would you like", no excluded word); "What test result did
 * you have last time?" is rejected (has "result" AND "last", both
 * excluded) even though it starts with "what" and mentions "test".
 * isAllowedTestValue below is STILL the deciding second layer regardless
 * of which name pattern matched — this name-side fix closes the gap where
 * a screening question could reach that second layer at all with a
 * value that might otherwise slip past a looser check.
 */
const TEST_FIELD_EXACT_NAME = "select tests";
const TEST_FIELD_NAME_PREFIX = "select test";

/** Forward-looking selection phrases — a name must contain at least ONE
 * of these (in addition to starting with which/what and mentioning
 * test(s)) to be treated as a test-selection question. */
const TEST_SELECTION_QUESTION_REQUIRED_PHRASES = [
  "would you like",
  "do you want",
  "are you here for",
  "to receive",
  "to schedule",
  "are you scheduling",
  "to be tested for",
  "select",
  "choose",
] as const;

/** Backward-looking/screening words — a name containing ANY of these is
 * NEVER a selection question, regardless of the required-phrase check
 * above (a screening question can coincidentally reuse a phrase like
 * "select" in an unrelated sense, so this exclusion list is checked
 * first and wins outright). */
const TEST_SELECTION_QUESTION_EXCLUDED_WORDS = [
  "result",
  "results",
  "positive",
  "negative",
  "taking",
  "medication",
  "medicine",
  "last",
  "previous",
  "prior",
  "history",
  "symptom",
] as const;

function normalizeFieldName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*:\s*$/, "")
    .trim();
}

/** See the isTestFormFieldName doc comment above for the full rationale —
 * `normalized` is already lowercase/trimmed (normalizeFieldName's output). */
function isTestSelectionQuestion(normalized: string): boolean {
  if (!/^(which|what)\b/.test(normalized)) return false;
  if (!/\btests?\b/.test(normalized)) return false;
  if (TEST_SELECTION_QUESTION_EXCLUDED_WORDS.some((word) => normalized.includes(word))) return false;
  return TEST_SELECTION_QUESTION_REQUIRED_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function isTestFormFieldName(name: string): boolean {
  if (typeof name !== "string") return false;
  const normalized = normalizeFieldName(name);
  if (normalized === TEST_FIELD_EXACT_NAME || normalized.startsWith(TEST_FIELD_NAME_PREFIX)) return true;
  return isTestSelectionQuestion(normalized);
}

/**
 * SECOND layer of the same PHI boundary (defense in depth, security
 * review 2026-09-08, TIGHTENED FURTHER 2026-09-09 — REQUEST_CHANGES,
 * blocking, BLOCKED feat/explorer-group-tables): even with
 * isTestFormFieldName's tightened name match above, this ALSO validates
 * every extracted VALUE before it's allowed to become a testName.
 *
 * ORIGINAL (2026-09-08) design used a per-token SUBSTRING match
 * (`lower.includes(token)`) — that let a value like "Positive for flu" or
 * "Truvada for HIV" through, since both CONTAIN an allowlisted substring
 * ("flu", "hiv") inside an otherwise free-text sentence that could be
 * real patient health information (a screening answer or a medication
 * name), i.e. exactly the PHI leak this boundary exists to prevent.
 *
 * FIXED to WHOLE-VALUE, EXACT-TOKEN matching: the raw answer is split into
 * tokens on [",", ";", "/", "&", " and ", "+"] (splitTestValueTokens) —
 * covering every multi-select join style actually seen ("COVID, Strep")
 * plus the plausible ones a free-text or differently-configured field
 * might use ("COVID/Strep", "COVID & Strep", "COVID and Strep"). Each
 * token is normalized (normalizeTestToken: strip a trailing price
 * qualifier, strip a trailing "test"/"tests"/"testing" word, lowercase,
 * collapse whitespace) and must be an EXACT member of
 * TEST_VALUE_TOKEN_ALLOWLIST below — not merely contain one. If ANY
 * resulting token fails that exact check, the ENTIRE value is rejected
 * (isAllowedTestValue returns false for the whole string) — there is no
 * partial acceptance of "the good half" of a mixed answer. "Positive for
 * flu" is ONE token (no separator present) that normalizes to "positive
 * for flu", which is not an exact allowlist member — rejected outright,
 * unlike the old substring match. "COVID, Strep" splits into two tokens
 * that both normalize to exact allowlist members — accepted, and used
 * as-is as the two returned test names. A free-text answer that happens
 * to land on a field this module misidentifies (or a field that's
 * legitimately named "Select tests:" but whose answer was, for whatever
 * reason, typed as free text) is dropped here rather than stored — NEVER
 * logged (a dropped value is, by definition, off this module's own
 * allowlist, so logging it would defeat the whole point of dropping it).
 */
const TEST_VALUE_TOKEN_ALLOWLIST = [
  "covid",
  "flu",
  "influenza",
  "strep",
  // "Strep Throat" (not just bare "Strep") is a real live-probed value
  // (see isTestFormFieldName's doc comment history) — kept as its own
  // exact-match entry, alongside "strep", now that matching is
  // whole-token/exact rather than substring.
  "strep throat",
  "rsv",
  "a1c",
  "glucose",
  "cholesterol",
  "lipid",
  "hiv",
  "hep",
] as const;

/** Separators splitTestValueTokens recognizes between individual test
 * names in one raw answer — covers the comma/pipe/newline join style the
 * live probe found plus the other plausible multi-item separators
 * (semicolon, slash, ampersand, "and", plus) a differently-configured or
 * free-text answer might use. Order matters only in that " and " (with
 * surrounding spaces, case-insensitive) must not also eat the "and" inside
 * an unrelated word — the surrounding spaces in the pattern prevent that. */
const TEST_VALUE_SEPARATOR_PATTERN = /,|\||\n|;|\/|&|\+| and /gi;

/** Splits one raw answer into trimmed, non-empty tokens on
 * TEST_VALUE_SEPARATOR_PATTERN — shared by isAllowedTestValue (validation)
 * and extractTestNamesFromForms (the actual returned display names), so
 * the two can never disagree on what counts as "one test name" within a
 * multi-value answer. */
function splitTestValueTokens(value: string): string[] {
  return value
    .split(TEST_VALUE_SEPARATOR_PATTERN)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Strips a trailing "test"/"tests"/"testing" word from an already-
 * trimmed name — e.g. "COVID test" -> "COVID" — so a plain-language
 * answer like "COVID test" still resolves to the SAME test name as a
 * bare "COVID" answer. A name that's ENTIRELY that word (rare/malformed)
 * is left as-is rather than stripped to "" (same "don't strip to empty"
 * rule stripPriceQualifier below already uses). */
function stripTrailingTestWord(name: string): string {
  const stripped = name.replace(/\s*\b(?:tests?|testing)\s*$/i, "").trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * Strips a trailing parenthetical qualifier — e.g. "COVID (free)" ->
 * "COVID" — from one already-trimmed test-name token. JUDGMENT CALL,
 * doc-commented per the brief: the live probe (see isTestFormFieldName)
 * found the SAME test ("COVID") answered both as "COVID" and "COVID
 * (free)" depending on a pricing option baked into the checkbox label —
 * without this normalization those would land in two separate columns of
 * the point-of-care test table (lib/poc-test-table.ts) for what is
 * obviously one test type, which would misrepresent "daily totals for
 * each type of test" (the exact ask). A qualifier that isn't a trailing
 * "(...)" is left alone; a token that's ENTIRELY parenthetical (rare/
 * malformed) is left as-is rather than stripped to "".
 */
function stripPriceQualifier(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped.length > 0 ? stripped : name;
}

/** Normalizes one already-split token for the EXACT allowlist comparison
 * (see isAllowedTestValue's doc comment): strip a trailing price
 * qualifier and a trailing "test"/"testing" word (same two
 * normalizations the DISPLAY name gets — see extractTestNamesFromForms —
 * so validation and display can never disagree on what a token
 * "means"), then lowercase and collapse whitespace. */
function normalizeTestToken(token: string): string {
  return stripTrailingTestWord(stripPriceQualifier(token.trim()))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A real test-type answer ("COVID", "Strep Throat", "COVID (free)") is
 * always short — this is generous headroom above the longest real value
 * observed live, not a tight fit, so it only ever rejects something that
 * has stopped looking like a short multi-select answer at all. Applied to
 * the WHOLE raw value (before splitting) — a value already this long is
 * free text regardless of how many tokens it would split into. */
const MAX_TEST_VALUE_LENGTH = 40;

/**
 * WHOLE-VALUE gate (security review 2026-09-09 — see the doc comment on
 * TEST_VALUE_TOKEN_ALLOWLIST above for the full before/after rationale):
 * splits `value` into tokens (splitTestValueTokens), and returns true only
 * if EVERY resulting token, once normalized (normalizeTestToken), is an
 * EXACT member of TEST_VALUE_TOKEN_ALLOWLIST. A single non-allowlisted
 * token anywhere in the value fails the WHOLE thing — there is no partial
 * acceptance. An empty value, a value with no tokens after splitting, or
 * one over MAX_TEST_VALUE_LENGTH is rejected outright.
 */
export function isAllowedTestValue(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEST_VALUE_LENGTH) return false;

  const tokens = splitTestValueTokens(trimmed);
  if (tokens.length === 0) return false;

  return tokens.every((token) => (TEST_VALUE_TOKEN_ALLOWLIST as readonly string[]).includes(normalizeTestToken(token)));
}

/**
 * V-T27 follow-up (Will, 2026-09-09): Acuity represents a checkbox/
 * multi-select answer as a comma/pipe/newline-joined STRING in the common
 * case (what every test above this point assumed) — but a real form's
 * checkbox field can instead come back with `value` as an ARRAY of the
 * individually-checked option strings. Joining that array with a comma
 * feeds it through the exact same split/strip/allowlist pipeline
 * extractTestNamesFromForms already uses for the string shape, so both
 * shapes are handled identically from this point on. Returns null (not [])
 * for anything that's neither a plain string nor an all-string array — a
 * mixed/object-bearing array isn't a shape this module knows how to parse
 * safely, so the whole field is skipped rather than guessed at (same
 * fail-closed rule as every other PHI-boundary check in this file).
 */
function coerceFormFieldValueToString(fieldValue: unknown): string | null {
  if (typeof fieldValue === "string") return fieldValue;
  if (Array.isArray(fieldValue) && fieldValue.every((entry) => typeof entry === "string")) {
    return (fieldValue as string[]).join(",");
  }
  return null;
}

/**
 * PHI boundary, same rule as extractVaccineNamesFromForms: must only ever
 * be called with `entry.forms`. Finds the first form field whose name
 * matches isTestFormFieldName and, ONLY when isAllowedTestValue accepts
 * the field's WHOLE raw answer (security review 2026-09-09 — see that
 * function's own doc comment for why this is now a whole-value gate, not
 * a per-token filter), splits that answer into individual display names
 * via the SAME splitTestValueTokens tokenizer the validation step used —
 * so a rejected value never partially leaks a "good half" through a
 * different split, and an accepted value's returned names are exactly the
 * tokens that were validated. Each display name still gets
 * stripPriceQualifier's "(free)"-style normalization and
 * stripTrailingTestWord's "COVID test" -> "COVID" normalization (the same
 * two normalizations normalizeTestToken applies for validation — kept in
 * sync deliberately). Returns [] if no matching field is found, its value
 * is blank/unparseable, or isAllowedTestValue rejected every matching
 * field's value — callers fall back to parsing the appointment type's own
 * name (see parseTestNamesFromAppointmentTypeName) only when this comes
 * back empty, exactly as the brief specifies.
 */
function extractTestNamesFromForms(forms: unknown): string[] {
  if (!Array.isArray(forms)) return [];

  for (const form of forms) {
    if (typeof form !== "object" || form === null) continue;
    const values = (form as Record<string, unknown>).values;
    if (!Array.isArray(values)) continue;

    for (const field of values) {
      if (typeof field !== "object" || field === null) continue;
      const fieldName = (field as Record<string, unknown>).name;
      if (typeof fieldName !== "string" || !isTestFormFieldName(fieldName)) continue;
      const rawValue = coerceFormFieldValueToString((field as Record<string, unknown>).value);
      if (rawValue === null) continue;
      // Whole-value gate — see isAllowedTestValue's doc comment: any
      // non-allowlisted token anywhere in this answer drops the ENTIRE
      // value, never just the offending piece.
      if (!isAllowedTestValue(rawValue)) continue;

      const names = splitTestValueTokens(rawValue)
        .map((name) => stripTrailingTestWord(stripPriceQualifier(name)))
        .filter((name) => name.length > 0);
      if (names.length > 0) return names;
    }
  }

  return [];
}

/**
 * Fallback path (V-T-poc-testing, brief: "fall back to parsing the
 * appointment type name's parenthetical ... only if no form field carries
 * the selection") — used ONLY when extractTestNamesFromForms above found
 * nothing. Acuity's raw appointment entry includes a `type` field carrying
 * the appointment type's own human-readable name inline (live-probed
 * 2026-09-08: `entry.type === "Test appointment (Flu, COVID, Strep)"` for
 * this account's test appointment type) — reading it here means this
 * fallback needs no second API call / no appointment-types map threaded
 * through this module, unlike aggregateAppointmentCounts's OWN vaccine-
 * name fallback (which needs the route's separately-fetched
 * appointmentTypeNames map, since it falls back to the WHOLE type name as
 * one name, not a parsed list). Extracts the LAST parenthesized group's
 * comma-separated contents, e.g. "Test appointment (Flu, COVID, Strep)" ->
 * ["Flu", "COVID", "Strep"]. When there's no parenthetical at all, falls
 * through to parseTestNameFromPlainTypeName below (V-T27 follow-up) for a
 * type configured as a single plain name like "COVID Test" rather than a
 * "Test appointment (...)" list. Returns [] only when NEITHER shape
 * matches or every parsed segment is blank.
 */
function parseTestNamesFromAppointmentTypeName(typeName: unknown): string[] {
  if (typeof typeName !== "string") return [];
  const trimmed = typeName.trim();

  const match = /\(([^)]*)\)\s*$/.exec(trimmed);
  if (match) {
    const names = match[1]
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) return names;
  }

  return parseTestNameFromPlainTypeName(trimmed);
}

/** Display label for each TEST_VALUE_TOKEN_ALLOWLIST token, used only by
 * parseTestNameFromPlainTypeName below — the allowlist itself stays
 * lowercase (it's matched case-insensitively against both form answers and
 * type names), this is purely presentation for the ONE path that has no
 * real patient-typed casing to preserve (a business-configured type name,
 * not a form answer). */
const TEST_VALUE_TOKEN_LABELS: Record<(typeof TEST_VALUE_TOKEN_ALLOWLIST)[number], string> = {
  covid: "COVID",
  flu: "Flu",
  influenza: "Influenza",
  strep: "Strep",
  "strep throat": "Strep Throat",
  rsv: "RSV",
  a1c: "A1C",
  glucose: "Glucose",
  cholesterol: "Cholesterol",
  lipid: "Lipid",
  hiv: "HIV",
  hep: "Hep",
};

/**
 * SECOND type-name fallback layer (V-T27, Will 2026-09-09 verbatim: "the
 * test named in the appointment TYPE instead of a form" was one of the
 * shapes the Tests column was dropping) — for a type with NO parenthetical
 * breakdown at all, e.g. a type literally named "COVID Test" or "Strep
 * Testing" rather than "Test appointment (Flu, COVID, Strep)". Only fires
 * when the type name's own LAST WORD is "test"/"tests"/"testing" —
 * deliberately narrower than a bare "mentions test somewhere" match, same
 * rationale isTestAppointmentTypeName's own doc comment gives for its
 * "COVID Vaccine + Test Visit" counter-example: a business-configured
 * label that plainly NAMES ITSELF a testing appointment, not a vaccine
 * visit that merely mentions testing in passing. Reuses the SAME
 * TEST_VALUE_TOKEN_ALLOWLIST form answers are checked against (via
 * isAllowedTestValue) rather than a second copy, so the two paths can
 * never drift out of sync on which test types are recognized — every
 * allowlisted token found anywhere in the name is returned (deduped),
 * labeled via TEST_VALUE_TOKEN_LABELS. Returns [] when the name doesn't
 * end in a "test"-family word, or ends in one but matches no allowlisted
 * token (e.g. "Insurance Verification Test" — not a real case, but this
 * function still correctly finds nothing to extract).
 */
function parseTestNameFromPlainTypeName(typeName: string): string[] {
  if (!/\b(?:test|tests|testing)$/i.test(typeName)) return [];

  const lower = typeName.toLowerCase();
  const names: string[] = [];
  for (const token of TEST_VALUE_TOKEN_ALLOWLIST) {
    if (lower.includes(token) && !names.includes(TEST_VALUE_TOKEN_LABELS[token])) {
      names.push(TEST_VALUE_TOKEN_LABELS[token]);
    }
  }
  return names;
}

/**
 * PHI boundary: reads the raw brand-preference answer (via
 * extractFormFieldAnswer/isCovidBrandFormFieldName) and immediately
 * buckets it — the raw string never leaves this function. "contains
 * pfizer" wins over "contains moderna" if somehow both appear; anything
 * else, including a missing/unmatched field, defaults to "any" per Will's
 * spec (no brand preference stated = no restriction).
 */
function deriveCovidBrand(forms: unknown): CovidBrand {
  const answer = extractFormFieldAnswer(forms, isCovidBrandFormFieldName);
  if (!answer) return "any";
  const lower = answer.toLowerCase();
  if (lower.includes("pfizer")) return "pfizer";
  if (lower.includes("moderna")) return "moderna";
  return "any";
}

/** Whole years between `dob` and `asOf`, or null if `dob` doesn't parse. */
/**
 * A bare "YYYY-MM-DD" is parsed by `new Date()` as UTC MIDNIGHT (per the
 * ES spec's date-time string format) — reading it back with local getters
 * (as computeAgeFromDob does, to compare against `asOf`) then lands on the
 * PREVIOUS calendar day in any timezone behind UTC, e.g. America/Chicago.
 * That's a silent off-by-one that can land a patient on the wrong side of
 * the 12th-birthday Pfizer-eligibility boundary right when it matters
 * most (caught by the exact-boundary test in tests/acuity-client.test.ts
 * — a plain numeric-age answer far from a boundary hid this bug for a
 * while). Parsed manually as local-time components instead; every other
 * format (e.g. "MM/DD/YYYY") is already parsed as local time natively.
 */
function parseDobAsLocalDate(dob: string): Date | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const local = new Date(Number(year), Number(month) - 1, Number(day));
    return Number.isNaN(local.getTime()) ? null : local;
  }
  const native = new Date(dob);
  return Number.isNaN(native.getTime()) ? null : native;
}

function computeAgeFromDob(dob: string, asOf: Date): number | null {
  const parsed = parseDobAsLocalDate(dob);
  if (!parsed) return null;

  let age = asOf.getFullYear() - parsed.getFullYear();
  const monthDiff = asOf.getMonth() - parsed.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < parsed.getDate())) {
    age -= 1;
  }
  return age;
}

/**
 * 3-11 / 12-64 / 65+ / unknown — anything outside [3, 110] (including <3)
 * buckets to unknown, per Will's spec. Revised ROUND 2 (Will 2026-09-05):
 * the old "12+" bucket now splits at 65 (12-64 / 65+) so every COVID
 * brand column has a senior-age split, matching bucketFluAge's own 65
 * cutoff below.
 */
function bucketCovidAge(age: number | null): CovidAgeBucket {
  if (age === null || !Number.isFinite(age) || age < 3 || age > 110) return "unknown";
  if (age <= 11) return "3-11";
  if (age <= 64) return "12-64";
  return "65+";
}

/**
 * 3-64 / 65+ / unknown (V-T-schedule-table ROUND 2, Will 2026-09-05).
 * Same [3, 110] valid-range rule as bucketCovidAge — ages 0-2, negative,
 * unparseable, or over 110 all bucket to "unknown" rather than a bogus
 * "3-64"/"65+".
 */
function bucketFluAge(age: number | null): FluAgeBucket {
  if (age === null || !Number.isFinite(age) || age < 3 || age > 110) return "unknown";
  return age <= 64 ? "3-64" : "65+";
}

/**
 * PHI boundary: reads the raw age-question answer ONCE (via
 * extractFormFieldAnswer/isAgeFormFieldName) and immediately converts it
 * to a plain number of years — neither the raw age number nor a raw DOB
 * string ever leaves this function's caller's call stack unbucketed. The
 * answer is either a plain numeric age ("12") or a parseable date of
 * birth ("2014-05-03", "05/03/2014", ...); anything else — missing field
 * or unparseable text — returns null. Shared by bucketCovidAge and
 * bucketFluAge (V-T-schedule-table ROUND 2: "same form-derived age
 * bucketing infrastructure as COVID") so a single form answer buckets
 * into both the COVID and Flu age columns without a second field lookup.
 */
function deriveAgeInYears(forms: unknown): number | null {
  const answer = extractFormFieldAnswer(forms, isAgeFormFieldName);
  if (!answer) return null;

  const age = /^\d+(\.\d+)?$/.test(answer) ? Math.floor(Number(answer)) : computeAgeFromDob(answer, new Date());
  return age === null || !Number.isFinite(age) ? null : age;
}

/**
 * "Does this vaccine name look like COVID" — case-insensitive substring
 * match on "covid", used by aggregateAppointmentCounts to decide whether
 * to replace a name with the brand/age composite (see covidCompositeName).
 */
function isCovidVaccineName(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().includes("covid");
}

/**
 * "Does this vaccine name look like Flu" (V-T-schedule-table ROUND 2,
 * same mechanism as isCovidVaccineName above) — used by
 * aggregateAppointmentCounts to decide whether to replace a name with the
 * age composite (see fluCompositeName). "flu" alone already matches
 * "influenza" and "flumist" as substrings, but both are listed explicitly
 * per Will's spec so the match stays obviously correct if "flu" is ever
 * narrowed.
 */
function isFluVaccineName(name: string): boolean {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase();
  return lower.includes("flu") || lower.includes("influenza") || lower.includes("flumist");
}

const COVID_BRAND_LABELS: Record<CovidBrand, string> = { pfizer: "Pfizer", moderna: "Moderna", any: "Any" };
const COVID_AGE_BUCKET_LABELS: Record<CovidAgeBucket, string> = {
  "3-11": "3-11",
  "12-64": "12-64",
  "65+": "65+",
  unknown: "Unknown",
};
const FLU_AGE_BUCKET_LABELS: Record<FluAgeBucket, string> = { "3-64": "3-64", "65+": "65+", unknown: "Unknown" };

/**
 * Builds the composite COVID column name — "COVID · Pfizer · 12+" — that
 * replaces any COVID-ish vaccineName in aggregateAppointmentCounts.
 * lib/appointment-table.ts parses this exact "COVID · {Brand} · {Age}"
 * shape (with " · " separators) to build the grouped table header — keep
 * the two in sync if this format ever changes.
 */
function covidCompositeName(brand: CovidBrand, ageBucket: CovidAgeBucket): string {
  return `COVID · ${COVID_BRAND_LABELS[brand]} · ${COVID_AGE_BUCKET_LABELS[ageBucket]}`;
}

/**
 * Builds the composite Flu column name — "Flu · <65" — that replaces any
 * Flu-ish vaccineName in aggregateAppointmentCounts (V-T-schedule-table
 * ROUND 2: "extend, don't fork, the existing composite mechanism" so the
 * age bucket rides through the VaccineCount cache/API shape unchanged,
 * same trick as covidCompositeName). lib/appointment-table.ts parses this
 * exact "Flu · {Age}" shape to map onto the fixed Flu <65/65+/(unk)
 * columns — keep the two in sync if this format ever changes.
 */
function fluCompositeName(ageBucket: FluAgeBucket): string {
  return `Flu · ${FLU_AGE_BUCKET_LABELS[ageBucket]}`;
}

/**
 * Internal-only shape: CountableAppointment plus the raw Acuity
 * appointment `id` (opaque integer, not PHI — no name/email/phone/notes
 * ever touch this type, same PHI boundary as CountableAppointment
 * itself). Exists purely so fetchAppointmentsForRange's recursive
 * pagination (below) can dedupe appointments that show up in two
 * adjacent sub-windows before returning — the id is stripped back off
 * before anything leaves this module, so CountableAppointment's public
 * shape (and everything callers/tests already assert about it) is
 * unchanged. `acuityId` is `null` on the defensive fallback path (a
 * missing/non-numeric `id` on the raw entry, which real Acuity responses
 * never produce per developers.acuityscheduling.com's documented shape)
 * — see the dedupe step in fetchAppointmentsForRange for why `null`
 * entries are never treated as duplicates of one another.
 */
type RawWindowAppointment = CountableAppointment & { acuityId: number | null };

/**
 * Fetches ONE page — a single Acuity request for [minDate, maxDate] (both
 * "YYYY-MM-DD", inclusive per Acuity's minDate/maxDate semantics), capped
 * at ACUITY_APPOINTMENTS_MAX rows — and strips every field down to
 * RawWindowAppointment. This is the single-request primitive
 * fetchAppointmentsForRange below recurses on; nothing outside this file
 * calls it directly.
 */
async function fetchAppointmentWindow(
  userId: string,
  apiKey: string,
  minDate: string,
  maxDate: string
): Promise<{ appointments: RawWindowAppointment[]; possiblyTruncated: boolean }> {
  const url = new URL(ACUITY_APPOINTMENTS_URL);
  url.searchParams.set("minDate", minDate);
  url.searchParams.set("maxDate", maxDate);
  url.searchParams.set("max", String(ACUITY_APPOINTMENTS_MAX));
  url.searchParams.set("canceled", "false");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: basicAuthHeader(userId, apiKey) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AcuityApiError(
      err instanceof Error ? `Could not reach Acuity: ${err.message}` : "Could not reach Acuity."
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AcuityApiError("Acuity rejected these credentials.");
  }

  if (!response.ok) {
    throw new AcuityApiError(`Acuity returned an unexpected status (${response.status}) for appointments.`);
  }

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new AcuityApiError("Acuity returned an unexpected appointments response.");
  }

  // Saturation signal: computed off the raw response length, before the
  // PHI-stripping/malformed-entry filtering below — a full page (exactly
  // ACUITY_APPOINTMENTS_MAX rows) means more may exist beyond it in this
  // window. fetchAppointmentsForRange below is what decides what to do
  // about that (split and recurse); this function just reports it.
  const possiblyTruncated = data.length === ACUITY_APPOINTMENTS_MAX;

  // PHI-stripping projection — see CountableAppointment doc comment.
  // Every other field on `entry` (name/email/phone/notes/...) is dropped
  // right here and never touched again — `datetimeCreated` (V-T-booking
  // -activity) is one addition, reduced to `createdDate` ("YYYY-MM-DD")
  // the same instant, exactly like `datetime` -> `date`; the raw
  // timestamp string itself never survives past this map step. `id`
  // (MSG-897) is the other addition — a bare opaque integer, kept ONLY
  // for this module's own dedupe step (see RawWindowAppointment) and
  // stripped before anything returns from fetchAppointmentsForRange.
  // `forms` is read ONLY through
  // extractVaccineNamesFromForms/extractTestNamesFromForms/deriveCovidBrand/
  // deriveAgeInYears, each of which extracts (and, for age, immediately
  // buckets via bucketCovidAge/bucketFluAge) only its own specific
  // question's answer — nothing else off `forms` survives this
  // projection, and the raw age/DOB string in particular never exists
  // outside deriveAgeInYears's call stack. covidAgeBucket and fluAgeBucket
  // (V-T-schedule-table ROUND 2) are two independent bucketings of the
  // SAME extracted age — one age-question lookup per appointment, not
  // two. `entry.type` (V-T-poc-testing) is the ONE other raw field read
  // here beyond `forms`/`id`/`datetime`/`datetimeCreated`/
  // `appointmentTypeID` — the appointment TYPE's own name, not patient
  // data, read only as extractTestNamesFromForms's fallback source (see
  // parseTestNamesFromAppointmentTypeName) and discarded the instant
  // testNames is derived from it.
  const appointments = data
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const ageInYears = deriveAgeInYears(entry.forms);
      const rawId = Number(entry.id);
      const testNames = extractTestNamesFromForms(entry.forms);
      return {
        date: acuityDatetimeToChicagoDate(entry.datetime),
        hourOfDay: acuityDatetimeToChicagoHour(entry.datetime),
        appointmentTypeId: Number(entry.appointmentTypeID),
        vaccineNames: extractVaccineNamesFromForms(entry.forms),
        // V-T-poc-testing: fall back to the appointment TYPE's own name
        // ONLY when no form field carried the selection — see
        // parseTestNamesFromAppointmentTypeName's doc comment for why
        // `entry.type` (not a second appointment-types fetch) is the
        // source.
        testNames: testNames.length > 0 ? testNames : parseTestNamesFromAppointmentTypeName(entry.type),
        covidBrand: deriveCovidBrand(entry.forms),
        covidAgeBucket: bucketCovidAge(ageInYears),
        fluAgeBucket: bucketFluAge(ageInYears),
        createdDate: acuityDatetimeToChicagoDate(entry.datetimeCreated),
        acuityId: Number.isFinite(rawId) ? rawId : null,
      };
    })
    .filter((entry) => entry.date && Number.isFinite(entry.appointmentTypeId));

  return { appointments, possiblyTruncated };
}

/** Whole calendar days between two "YYYY-MM-DD" strings (maxDate - minDate)
 * — pure date-component math via a fixed UTC-noon anchor, same DST-proof
 * approach as lib/chicago-date.ts's addDaysToChicagoDate, so this is never
 * off by one around a spring/fall DST boundary. */
function daysBetweenChicagoDates(minDate: string, maxDate: string): number {
  const [y1, m1, d1] = minDate.split("-").map(Number);
  const [y2, m2, d2] = maxDate.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1, 12);
  const b = Date.UTC(y2, m2 - 1, d2, 12);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Fetches every appointment in [minDate, maxDate] and strips every field
 * down to CountableAppointment — see that type above for the PHI boundary.
 *
 * MSG-897 (Will: "the app must be reliable regardless of volume" —
 * "warning stays" isn't the end state when a deterministic workaround
 * exists). Acuity's `max` param caps a single request at
 * ACUITY_APPOINTMENTS_MAX (100) rows with no documented offset/pagination
 * param (see AppointmentRangeResult.possiblyTruncated's doc comment for
 * the live-docs verification) — but it DOES accept minDate/maxDate, so a
 * saturated window can be paginated by DATE instead: split it in half and
 * fetch each half. Algorithm, run per top-level call:
 *
 *   1. Fetch [minDate, maxDate] (one request).
 *   2. If the response isn't saturated (< max rows), this window is
 *      COMPLETE — done, no further requests.
 *   3. If saturated and minDate === maxDate (a single calendar day), this
 *      is the recursion FLOOR — a day can't be split any further. Keep
 *      what came back and flag possiblyTruncated (residual case #1 — see
 *      that field's doc comment).
 *   4. Otherwise, split [minDate, maxDate] at its date midpoint into two
 *      contiguous, non-overlapping halves and recurse on each IN
 *      PARALLEL (Promise.all — halving instead of scanning keeps this
 *      fast: a window that needs N requests takes O(log N) sequential
 *      rounds, not N).
 *
 * REQUESTS_PER_RANGE_BUDGET bounds the total requests one top-level call
 * can issue — checked before every request, including the first split's
 * children, so a window that keeps coming back saturated no matter how
 * finely it's cut (implausible in practice; see that constant's doc
 * comment) can't run away. Hitting the budget bails out the same way
 * hitting the single-day floor does: keep whatever was already fetched
 * and flag possiblyTruncated (residual case #2), plus a console.warn so
 * this is visible in logs if it ever actually fires.
 *
 * DEDUPE: Acuity's minDate/maxDate docs don't specify whether a boundary
 * appointment could appear in both an adjacent day's "before" and
 * "after" query (this module already treats them as inclusive on both
 * ends per the original doc comment here) — rather than trust that,
 * every appointment's raw Acuity id is tracked through the recursion
 * (RawWindowAppointment.acuityId) and deduped (dedupeByAcuityId) at every
 * point two separately-fetched sub-windows are combined, regardless of
 * whether an overlap is actually possible — this naturally covers the
 * whole tree, however deep, without a separate final pass. A single
 * request's own results are never deduped against themselves (see
 * fetchWindowRecursive) — only ever against a SEPARATE request's
 * results — since a real Acuity response never lists the same
 * appointment twice within itself. An entry with no parseable id
 * (acuityId: null — never happens on a real Acuity response, only a
 * defensive fallback) is never treated as a duplicate of anything,
 * including another null-id entry, so malformed data can't be
 * miscounted as an accidental collision.
 *
 * ORDERING: the merged list is in ascending-by-sub-range order (earliest
 * window's results first) — every caller of this function
 * (aggregateAppointmentCounts, aggregateHourlyCounts) re-sorts its own
 * output by date before returning, so no caller in this codebase actually
 * depends on fetchAppointmentsForRange's own result order.
 *
 * Caching is UNCHANGED: callers (app/api/acuity/poll/route.ts,
 * lib/acuity-future-summary.ts, lib/acuity-booking-activity.ts) still
 * call this once per window and cache its result under that SAME
 * (minDate, maxDate) key exactly as before — the pagination here is
 * entirely internal to this one call.
 */
export async function fetchAppointmentsForRange(
  userId: string,
  apiKey: string,
  minDate: string,
  maxDate: string
): Promise<AppointmentRangeResult> {
  const budget = { remaining: REQUESTS_PER_RANGE_BUDGET };

  async function fetchWindowRecursive(
    min: string,
    max: string
  ): Promise<{ appointments: RawWindowAppointment[]; possiblyTruncated: boolean }> {
    if (budget.remaining <= 0) {
      console.warn(
        `fetchAppointmentsForRange: REQUESTS_PER_RANGE_BUDGET (${REQUESTS_PER_RANGE_BUDGET}) exhausted before [${min}..${max}] could be confirmed complete for the overall range [${minDate}..${maxDate}] — keeping what was already fetched and flagging possiblyTruncated`
      );
      return { appointments: [], possiblyTruncated: true };
    }
    // Synchronous check-then-decrement, no `await` between them — safe
    // against the parallel Promise.all recursion below even though JS
    // has no locks, because nothing can interleave between two
    // synchronous statements in the same tick.
    budget.remaining -= 1;

    const { appointments, possiblyTruncated } = await fetchAppointmentWindow(userId, apiKey, min, max);
    // A single request's own results are returned as-is, undeduped — a
    // real Acuity response never lists the same appointment twice within
    // itself, so there's nothing to dedupe yet at this point (dedup
    // happens below, only where two SEPARATE requests' results are about
    // to be combined — see this function's doc comment on why a boundary
    // appointment could appear in both).
    if (!possiblyTruncated) return { appointments, possiblyTruncated: false };
    if (min === max) return { appointments, possiblyTruncated: true };

    const span = daysBetweenChicagoDates(min, max);
    const half = Math.floor(span / 2);
    const leftMax = addDaysToChicagoDate(min, half);
    const rightMin = addDaysToChicagoDate(leftMax, 1);

    const [left, right] = await Promise.all([fetchWindowRecursive(min, leftMax), fetchWindowRecursive(rightMin, max)]);

    return {
      appointments: dedupeByAcuityId([...left.appointments, ...right.appointments]),
      possiblyTruncated: left.possiblyTruncated || right.possiblyTruncated,
    };
  }

  const { appointments: merged, possiblyTruncated } = await fetchWindowRecursive(minDate, maxDate);
  const appointments: CountableAppointment[] = merged.map(({ acuityId: _acuityId, ...rest }) => rest);

  return { appointments, possiblyTruncated };
}

/**
 * Drops any appointment whose acuityId has already been seen earlier in
 * `list`, preserving order of first occurrence — used only where two
 * separately-fetched sub-windows are being combined (see
 * fetchWindowRecursive above), never on a single request's own raw
 * results. `null` (no parseable id — a defensive fallback that never
 * happens on a real Acuity response) is never treated as a duplicate of
 * anything, including another null entry, so malformed data can't be
 * miscounted as an accidental collision.
 */
function dedupeByAcuityId(list: RawWindowAppointment[]): RawWindowAppointment[] {
  const seenIds = new Set<number>();
  const deduped: RawWindowAppointment[] = [];
  for (const appointment of list) {
    if (appointment.acuityId !== null) {
      if (seenIds.has(appointment.acuityId)) continue;
      seenIds.add(appointment.acuityId);
    }
    deduped.push(appointment);
  }
  return deduped;
}

export type VaccineCount = {
  date: string;
  vaccineName: string;
  count: number;
};

/**
 * True when an appointment TYPE's own name looks like a point-of-care
 * testing type. Tightened per security review (2026-09-08, REQUEST_CHANGES
 * — same pass that tightened isTestFormFieldName above): a bare substring
 * match on "test" would also match a genuine VACCINE appointment type
 * whose name just happens to mention testing/screening in passing (e.g. a
 * hypothetical "COVID Vaccine + Test Visit") and, more subtly, is simply
 * the wrong shape of heuristic for a business-configured label — staff
 * name appointment types deliberately and predictably, unlike a patient's
 * free-text form answer, so this matches the two patterns actually
 * observed/plausible for a testing type: starts with "test appointment"
 * (the live-probed real name, "Test appointment (Flu, COVID, Strep)") or
 * mentions "point of care" / the "poc" abbreviation as its own word (not a
 * substring of an unrelated word — see the \bpoc\b comment below). Used
 * ONLY by aggregateAppointmentCounts's type-name-fallback guard (see its
 * doc comment) to stop a point-of-care testing appointment's own type name
 * from being misinterpreted as a vaccine appointment (the real name above
 * contains "covid" as a substring, so isCovidVaccineName would otherwise
 * happily rewrite it into a bogus "COVID · ..." vaccine-table entry). A
 * genuine vaccine type name like "Latest vaccines (fall)" matches none of
 * these and is correctly left alone.
 */
function isTestAppointmentTypeName(name: string): boolean {
  if (typeof name !== "string") return false;
  const lower = name.toLowerCase().trim();
  if (lower.startsWith("test appointment")) return true;
  if (lower.includes("point of care")) return true;
  // \bpoc\b, not a bare .includes("poc") — "poc" is a real substring of
  // ordinary unrelated words (e.g. "epoch"), which a plain substring match
  // would misclassify as a testing type.
  return /\bpoc\b/.test(lower);
}

/**
 * Pure aggregation: groups already-PHI-stripped appointments by
 * (date, vaccineName) and counts them. `vaccineName` is normally each of
 * an appointment's `vaccineNames` (see CountableAppointment) — an
 * appointment with two vaccine names counts once toward EACH name, not
 * split fractionally. When an appointment has no vaccineNames (its form
 * didn't have a field isVaccineFormFieldName matched, or Acuity returned
 * no forms at all), this falls back to the appointment type's name, same
 * behavior as before the vaccine-name pivot existed. Only ever reads
 * `.date`, `.appointmentTypeId`, `.vaccineNames`, `.testNames`,
 * `.covidBrand`, `.covidAgeBucket`, and `.fluAgeBucket` off each input —
 * see CountableAppointment.
 *
 * COVID brand/age split (V-T-schedule-table, Will 2026-09-04): any name
 * that looks like COVID (isCovidVaccineName) is replaced with the
 * appointment's own composite "COVID · {Brand} · {Age}" name
 * (covidCompositeName) before grouping, so the COVID column splits into
 * one column per (brand, age bucket) actually seen — e.g. an appointment
 * whose form answer is "COVID-Pfizer" with covidAgeBucket "12+" groups
 * under "COVID · Pfizer · 12+", not the raw form answer.
 *
 * Flu age split (V-T-schedule-table ROUND 2, Will 2026-09-05): same
 * mechanism — any name that looks like Flu (isFluVaccineName) is replaced
 * with the appointment's own composite "Flu · {Age}" name
 * (fluCompositeName) so the VaccineCount cache/API shape stays
 * {date, vaccineName, count} unchanged while the age bucket still rides
 * through it. lib/appointment-table.ts (client-safe, no PHI ever reaches
 * it) parses this composite back into the fixed Flu <65/65+/(unk)
 * columns.
 *
 * V-T-poc-testing follow-up (manager, 2026-09-08 — closing the gap flagged
 * in the original point-of-care-testing brief): a point-of-care testing
 * appointment must NEVER count as a vaccine via the type-name fallback
 * above. Rule, checked ONLY in the vaccineNames-empty branch (an
 * appointment WITH explicit vaccineNames from the vaccine form field
 * always counts under those names normally, test-type or not — a hybrid
 * visit, e.g. a test-type appointment where the patient ALSO got a
 * vaccine, still counts as that vaccine): if the appointment's own
 * `testNames` is non-empty (a "Select tests:"-style field matched, or its
 * type name's own parenthetical fallback fired — see
 * extractTestNamesFromForms/parseTestNamesFromAppointmentTypeName) OR the
 * resolved type name itself looks test-ish (isTestAppointmentTypeName —
 * covers the residual case where NEITHER produced a testNames value, e.g.
 * a test-type appointment whose name has no parenthetical list at all),
 * this appointment is skipped entirely here — it contributes nothing to
 * the vaccine table, only to aggregateTestCounts. A genuine vaccine-type
 * appointment with no form answer (testNames always [] for those, and its
 * type name never matches "test") still falls back to its type name
 * exactly as before — this guard changes nothing for that case.
 * app/api/ordering/recommendation/route.ts consumes this SAME aggregate
 * for its `upcoming7d` counts, so it inherits this fix automatically, with
 * no changes of its own needed.
 */
export function aggregateAppointmentCounts(
  appointments: CountableAppointment[],
  appointmentTypeNames: Map<number, string>
): VaccineCount[] {
  const groups = new Map<string, VaccineCount>();

  for (const { date, appointmentTypeId, vaccineNames, testNames, covidBrand, covidAgeBucket, fluAgeBucket } of appointments) {
    let names: string[];
    if (vaccineNames.length > 0) {
      names = vaccineNames;
    } else {
      const typeName = appointmentTypeNames.get(appointmentTypeId) ?? `Type ${appointmentTypeId}`;
      if (testNames.length > 0 || isTestAppointmentTypeName(typeName)) continue;
      names = [typeName];
    }

    for (const rawName of names) {
      const vaccineName = isCovidVaccineName(rawName)
        ? covidCompositeName(covidBrand ?? "any", covidAgeBucket ?? "unknown")
        : isFluVaccineName(rawName)
          ? fluCompositeName(fluAgeBucket ?? "unknown")
          : rawName;
      const key = `${date}::${vaccineName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      groups.set(key, { date, vaccineName, count: 1 });
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.vaccineName.localeCompare(b.vaccineName)
  );
}

export type HourlyCount = {
  date: string; // "YYYY-MM-DD"
  hour: number; // 0-23, America/Chicago — see CountableAppointment.hourOfDay
  /** Number of distinct appointments in this (date, hour) bucket. */
  appointmentCount: number;
  /**
   * Number of vaccines administered in this bucket — a multi-vaccine visit
   * (e.g. Flu + COVID in one appointment) counts once toward EACH vaccine,
   * same "count each name, not the visit" rule aggregateAppointmentCounts
   * uses for its own `count`. An appointment with no matched vaccine-name
   * form field falls back to counting as exactly 1 vaccine (matching
   * aggregateAppointmentCounts's own appointment-type-name fallback) —
   * this function doesn't need the appointment-type name itself, only how
   * many names would have been produced, so it takes no
   * `appointmentTypeNames` map.
   */
  vaccineCount: number;
};

/**
 * Pure aggregation, parallel to aggregateAppointmentCounts but bucketed by
 * (date, hour) instead of (date, vaccineName) — see HourlyCount above for
 * the exact counting rules (V-T-hourly-table, Will 2026-09-05: "hourly
 * breakdown of how many vaccines are scheduled by the hour from 8-6").
 * Only ever reads `.date`, `.hourOfDay`, and `.vaccineNames` off each input
 * — no PHI, same boundary as aggregateAppointmentCounts. Every hour 0-23 is
 * included here, not just the 8-17 "business hours" window the dashboard
 * displays — lib/appointment-table.ts's buildHourlyBreakdownTable is what
 * folds anything outside 8-17 into a day's "outside 8-6" total, so this
 * aggregation stays a complete, unopinionated summary of the full day.
 * `hourOfDay` values outside [0, 23] (the -1 sentinel from
 * acuityDatetimeToChicagoHour) are defensively skipped — in practice this
 * never happens, since fetchAppointmentsForRange only returns entries whose
 * `date` (and therefore `hourOfDay`, derived from the same instant) parsed
 * successfully.
 */
export function aggregateHourlyCounts(appointments: CountableAppointment[]): HourlyCount[] {
  const groups = new Map<string, HourlyCount>();

  for (const { date, hourOfDay, vaccineNames } of appointments) {
    if (hourOfDay < 0 || hourOfDay > 23) continue;

    const vaccineCountForEntry = vaccineNames.length > 0 ? vaccineNames.length : 1;
    const key = `${date}::${hourOfDay}`;
    const existing = groups.get(key);
    if (existing) {
      existing.appointmentCount += 1;
      existing.vaccineCount += vaccineCountForEntry;
      continue;
    }
    groups.set(key, { date, hour: hourOfDay, appointmentCount: 1, vaccineCount: vaccineCountForEntry });
  }

  return Array.from(groups.values()).sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
}

export type TestCount = {
  date: string;
  testName: string;
  count: number;
};

/**
 * Pure aggregation for the point-of-care testing table (V-T-poc-testing,
 * Will 2026-09-08: "a point of care testing appointment table too that
 * shows daily totals for each type of test that is scheduled"). Parallel
 * in SHAPE to aggregateAppointmentCounts (groups by (date, name) and
 * counts, one bump per name so a 2-test appointment counts once toward
 * EACH test) but DELIBERATELY DIFFERENT in one respect: an appointment
 * with an empty `testNames` contributes NOTHING here — there is no
 * "fall back to the appointment type name" step like
 * aggregateAppointmentCounts has for vaccines. That fallback exists there
 * because EVERY appointment needs to land somewhere in the vaccine table;
 * here it would be actively wrong — every non-test appointment (a real
 * vaccine visit) also has an empty `testNames`, and falling back to ITS
 * OWN appointment-type name would flood the point-of-care test table with
 * every vaccine appointment type as a bogus "test" column. Only genuine
 * point-of-care testing appointments (testNames populated via
 * extractTestNamesFromForms or its appointment-type-name fallback — see
 * CountableAppointment.testNames) ever appear in the output.
 */
export function aggregateTestCounts(appointments: CountableAppointment[]): TestCount[] {
  const groups = new Map<string, TestCount>();

  for (const { date, testNames } of appointments) {
    for (const testName of testNames) {
      const key = `${date}::${testName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      groups.set(key, { date, testName, count: 1 });
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.testName.localeCompare(b.testName)
  );
}
