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
};

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
  // Every other field on `entry` (name/email/phone/notes/forms/...) is
  // dropped right here and never touched again.
  const appointments = data
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      date: acuityDatetimeToChicagoDate(entry.datetime),
      appointmentTypeId: Number(entry.appointmentTypeID),
    }))
    .filter((entry) => entry.date && Number.isFinite(entry.appointmentTypeId));

  return { appointments, possiblyTruncated };
}

export type AppointmentTypeCount = {
  date: string;
  appointmentTypeId: number;
  appointmentTypeName: string;
  count: number;
};

/**
 * Pure aggregation: groups already-PHI-stripped appointments by
 * (date, appointmentTypeId) and counts them, labeling each group with the
 * matching appointment type's name. Only ever reads `.date` and
 * `.appointmentTypeId` off each input — see CountableAppointment.
 */
export function aggregateAppointmentCounts(
  appointments: CountableAppointment[],
  appointmentTypeNames: Map<number, string>
): AppointmentTypeCount[] {
  const groups = new Map<string, AppointmentTypeCount>();

  for (const { date, appointmentTypeId } of appointments) {
    const key = `${date}::${appointmentTypeId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      date,
      appointmentTypeId,
      appointmentTypeName: appointmentTypeNames.get(appointmentTypeId) ?? `Type ${appointmentTypeId}`,
      count: 1,
    });
  }

  return Array.from(groups.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.appointmentTypeName.localeCompare(b.appointmentTypeName)
  );
}
