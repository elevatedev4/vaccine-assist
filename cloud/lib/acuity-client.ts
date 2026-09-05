import "server-only";
import { chicagoDateString } from "@/lib/chicago-date";

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
   * matched by isAgeFormFieldName (see deriveCovidAgeBucket), which reads
   * either a plain numeric age or a date of birth. CRITICAL: the raw age
   * number and the raw DOB string are both read ONLY inside
   * deriveCovidAgeBucket/computeAgeFromDob and are discarded the instant
   * they're bucketed — neither the exact age nor the DOB ever becomes
   * part of this type, an API response, a cache row, or a log line.
   */
  covidAgeBucket: CovidAgeBucket;
};

/** Brand-preference bucket for a COVID appointment — see covidBrand above. */
export type CovidBrand = "pfizer" | "moderna" | "any";

/** Age bucket for a COVID appointment — see covidAgeBucket above. */
export type CovidAgeBucket = "3-11" | "12+" | "unknown";

export type AppointmentRangeResult = {
  appointments: CountableAppointment[];
  /**
   * True when the raw Acuity response came back at exactly the requested
   * `max` cap (100) — a signal, not a certainty, that more appointments
   * exist in the range than were returned (Acuity's API documents no
   * offset/pagination param, so there's no way to fetch a next page).
   * Callers must surface this rather than silently under-counting.
   */
  possiblyTruncated: boolean;
};

const ACUITY_APPOINTMENTS_MAX = 100;

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
 * (deriveCovidBrand, deriveCovidAgeBucket) MUST bucket this raw string
 * immediately and never let it escape further — see CountableAppointment's
 * covidBrand/covidAgeBucket doc comments.
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

/** 3-11 / 12+ / unknown — anything outside [3, 110] (including <3) buckets to unknown, per Will's spec. */
function bucketAge(age: number): CovidAgeBucket {
  if (!Number.isFinite(age)) return "unknown";
  if (age >= 3 && age <= 11) return "3-11";
  if (age >= 12 && age <= 110) return "12+";
  return "unknown";
}

/**
 * PHI boundary: reads the raw age-question answer (via
 * extractFormFieldAnswer/isAgeFormFieldName) and immediately buckets it —
 * neither the raw age number nor a raw DOB string ever leaves this
 * function. The answer is either a plain numeric age ("12") or a
 * parseable date of birth ("2014-05-03", "05/03/2014", ...); anything
 * else — missing field, unparseable text, or an age outside [3, 110] —
 * buckets to "unknown" rather than guessing.
 */
function deriveCovidAgeBucket(forms: unknown): CovidAgeBucket {
  const answer = extractFormFieldAnswer(forms, isAgeFormFieldName);
  if (!answer) return "unknown";

  const age = /^\d+(\.\d+)?$/.test(answer) ? Math.floor(Number(answer)) : computeAgeFromDob(answer, new Date());

  if (age === null) return "unknown";
  return bucketAge(age);
}

/**
 * "Does this vaccine name look like COVID" — case-insensitive substring
 * match on "covid", used by aggregateAppointmentCounts to decide whether
 * to replace a name with the brand/age composite (see covidCompositeName).
 */
function isCovidVaccineName(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().includes("covid");
}

const COVID_BRAND_LABELS: Record<CovidBrand, string> = { pfizer: "Pfizer", moderna: "Moderna", any: "Any" };
const COVID_AGE_BUCKET_LABELS: Record<CovidAgeBucket, string> = { "3-11": "3-11", "12+": "12+", unknown: "Unknown" };

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
 * Fetches appointments in [minDate, maxDate] (both "YYYY-MM-DD", inclusive
 * per Acuity's minDate/maxDate semantics) and strips every field down to
 * {date, appointmentTypeId} — see CountableAppointment above.
 *
 * Acuity's documented `max` param defaults to 100 with no documented
 * offset/pagination parameter, so a range that actually contains more
 * than 100 appointments cannot be fully fetched — see possiblyTruncated
 * above, which the caller (the poll route) must propagate through the
 * cache and into the dashboard as a visible warning rather than silently
 * under-counting.
 */
export async function fetchAppointmentsForRange(
  userId: string,
  apiKey: string,
  minDate: string,
  maxDate: string
): Promise<AppointmentRangeResult> {
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

  // Truncation signal: computed off the raw response length, before the
  // PHI-stripping/malformed-entry filtering below — a full page (exactly
  // ACUITY_APPOINTMENTS_MAX rows) means more may exist beyond it.
  const possiblyTruncated = data.length === ACUITY_APPOINTMENTS_MAX;

  // PHI-stripping projection — see CountableAppointment doc comment.
  // Every other field on `entry` (name/email/phone/notes/...) is dropped
  // right here and never touched again. `forms` is read ONLY through
  // extractVaccineNamesFromForms/deriveCovidBrand/deriveCovidAgeBucket,
  // each of which extracts (and, for brand/age, immediately buckets) only
  // its own specific question's answer — nothing else off `forms`
  // survives this projection, and the raw age/DOB string in particular
  // never exists outside deriveCovidAgeBucket's call stack.
  const appointments = data
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      date: acuityDatetimeToChicagoDate(entry.datetime),
      appointmentTypeId: Number(entry.appointmentTypeID),
      vaccineNames: extractVaccineNamesFromForms(entry.forms),
      covidBrand: deriveCovidBrand(entry.forms),
      covidAgeBucket: deriveCovidAgeBucket(entry.forms),
    }))
    .filter((entry) => entry.date && Number.isFinite(entry.appointmentTypeId));

  return { appointments, possiblyTruncated };
}

export type VaccineCount = {
  date: string;
  vaccineName: string;
  count: number;
};

/**
 * Pure aggregation: groups already-PHI-stripped appointments by
 * (date, vaccineName) and counts them. `vaccineName` is normally each of
 * an appointment's `vaccineNames` (see CountableAppointment) — an
 * appointment with two vaccine names counts once toward EACH name, not
 * split fractionally. When an appointment has no vaccineNames (its form
 * didn't have a field isVaccineFormFieldName matched, or Acuity returned
 * no forms at all), this falls back to the appointment type's name, same
 * behavior as before the vaccine-name pivot existed. Only ever reads
 * `.date`, `.appointmentTypeId`, `.vaccineNames`, `.covidBrand`, and
 * `.covidAgeBucket` off each input — see CountableAppointment.
 *
 * COVID brand/age split (V-T-schedule-table, Will 2026-09-04): any name
 * that looks like COVID (isCovidVaccineName) is replaced with the
 * appointment's own composite "COVID · {Brand} · {Age}" name
 * (covidCompositeName) before grouping, so the COVID column splits into
 * one column per (brand, age bucket) actually seen — e.g. an appointment
 * whose form answer is "COVID-Pfizer" with covidAgeBucket "12+" groups
 * under "COVID · Pfizer · 12+", not the raw form answer.
 */
export function aggregateAppointmentCounts(
  appointments: CountableAppointment[],
  appointmentTypeNames: Map<number, string>
): VaccineCount[] {
  const groups = new Map<string, VaccineCount>();

  for (const { date, appointmentTypeId, vaccineNames, covidBrand, covidAgeBucket } of appointments) {
    const names =
      vaccineNames.length > 0
        ? vaccineNames
        : [appointmentTypeNames.get(appointmentTypeId) ?? `Type ${appointmentTypeId}`];

    for (const rawName of names) {
      const vaccineName = isCovidVaccineName(rawName)
        ? covidCompositeName(covidBrand ?? "any", covidAgeBucket ?? "unknown")
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
