import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
  isVaccineFormFieldName,
  testAcuityConnection,
} from "@/lib/acuity-client";

describe("testAcuityConnection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails fast without making a request when either field is empty", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await testAcuityConnection("", "some-key");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/required/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports success and never includes the key in the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: "Orchards Drug" }), { status: 200 })
      )
    );

    const result = await testAcuityConnection("user-123", "super-secret-key");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Orchards Drug");
    expect(result.message).not.toContain("super-secret-key");
  });

  it("reports a clear failure on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    const result = await testAcuityConnection("user-123", "wrong-key");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected/i);
  });

  it("reports a clear failure on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await testAcuityConnection("user-123", "some-key");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not reach acuity/i);
  });
});

// A fixture appointment shaped like a REAL Acuity API response — includes
// every PHI field Acuity actually returns (firstName/lastName/phone/email/
// notes/forms) precisely so the assertions below can prove none of it
// survives fetchAppointmentsForRange's projection. Also shaped to match
// Acuity's actual `date`/`datetime` formats (verified against
// developers.acuityscheduling.com's sample response): `date` is a
// human-readable string ("August 17, 2026"), NOT "YYYY-MM-DD" — an
// earlier version of this code wrongly assumed it was ISO-formatted and
// used it directly, which meant no appointment's date ever matched a
// "YYYY-MM-DD" range/day key downstream (see acuity-client.ts's
// CountableAppointment doc comment for the full story). `datetime` is
// the reliable ISO 8601 + UTC-offset field this code now reads instead.
function acuityAppointmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    firstName: "Jane",
    lastName: "Doe",
    phone: "555-123-4567",
    email: "jane.doe@example.com",
    date: "August 17, 2026",
    time: "10:00am",
    datetime: "2026-08-17T10:00:00-0500",
    appointmentTypeID: 111,
    notes: "Allergic to eggs",
    forms: [{ id: 1, name: "Intake", values: [] }],
    ...overrides,
  };
}

describe("fetchAppointmentsForRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips every field down to {date, appointmentTypeId, vaccineNames} — no PHI keys survive", async () => {
    const fixture = [
      acuityAppointmentFixture(),
      acuityAppointmentFixture({
        id: 67890,
        firstName: "John",
        lastName: "Smith",
        date: "August 18, 2026",
        datetime: "2026-08-18T09:00:00-0500",
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result.possiblyTruncated).toBe(false);
    expect(result.appointments).toEqual([
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [] },
      { date: "2026-08-18", appointmentTypeId: 111, vaccineNames: [] },
    ]);

    const phiKeys = ["firstName", "lastName", "phone", "email", "notes", "forms", "id", "time"];
    for (const entry of result.appointments) {
      for (const key of phiKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }
    }
  });

  // The vaccine-name pivot (V-T-something, Will 2026-08-19): the exact
  // vaccine(s) a patient is getting come from an Acuity intake-form
  // question, not the generic appointment-type name. See
  // isVaccineFormFieldName's doc comment for why the field-name match is
  // a heuristic that needs live verification against Will's real form.
  describe("vaccine name extraction from forms", () => {
    it("extracts a single vaccine name from a form field matching 'vaccine' (case-insensitive)", async () => {
      const fixture = [
        acuityAppointmentFixture({
          forms: [
            {
              id: 1,
              name: "Intake",
              values: [{ fieldID: 9, name: "Which Vaccine(s) are you receiving?", value: "Flu" }],
            },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([{ date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu"] }]);
    });

    it("splits a comma-separated multi-vaccine answer into individual trimmed names", async () => {
      const fixture = [
        acuityAppointmentFixture({
          forms: [
            {
              id: 1,
              name: "Intake",
              values: [{ fieldID: 9, name: "vaccine question", value: "COVID-Pfizer,  Flu ,RSV" }],
            },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([
        { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["COVID-Pfizer", "Flu", "RSV"] },
      ]);
    });

    it("splits a pipe- or newline-separated multi-vaccine answer too, dropping empty entries", async () => {
      const fixture = [
        acuityAppointmentFixture({
          id: 1,
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Vaccine", value: "Flu|COVID-Moderna|" }] }],
        }),
        acuityAppointmentFixture({
          id: 2,
          date: "August 18, 2026",
          datetime: "2026-08-18T09:00:00-0500",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Vaccine", value: "Flu\nRSV" }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([
        { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu", "COVID-Moderna"] },
        { date: "2026-08-18", appointmentTypeId: 111, vaccineNames: ["Flu", "RSV"] },
      ]);
    });

    it("falls back to an empty vaccineNames list (caller falls back to appointmentTypeName) when no form field matches", async () => {
      const fixture = [
        acuityAppointmentFixture({
          forms: [
            { id: 1, name: "Intake", values: [{ fieldID: 9, name: "Insurance provider", value: "Acme Health" }] },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([{ date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [] }]);
    });

    it("falls back to an empty vaccineNames list when the account has no forms at all", async () => {
      const fixture = [acuityAppointmentFixture({ forms: undefined })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([{ date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [] }]);
    });
  });

  describe("isVaccineFormFieldName", () => {
    it("matches field names containing 'vaccine' case-insensitively", () => {
      expect(isVaccineFormFieldName("Which vaccine(s) are you receiving?")).toBe(true);
      expect(isVaccineFormFieldName("VACCINE TYPE")).toBe(true);
      expect(isVaccineFormFieldName("Preferred Vaccine")).toBe(true);
    });

    it("does not match unrelated field names", () => {
      expect(isVaccineFormFieldName("Insurance provider")).toBe(false);
      expect(isVaccineFormFieldName("Date of birth")).toBe(false);
      expect(isVaccineFormFieldName("")).toBe(false);
    });
  });

  // Reproduces the reported bug: Will booked a real appointment ~10pm
  // Central. A naive `datetime.toISOString().slice(0, 10)` (UTC day) or
  // Acuity's own human-readable `date` field would silently push a
  // late-evening Central appointment to the next day (or fail to match a
  // "YYYY-MM-DD" key at all) — see CountableAppointment's doc comment.
  // Fixed by deriving the day from `datetime` (ISO + Central UTC offset)
  // re-rendered in America/Chicago.
  it("assigns a 10pm Central appointment to the Central calendar day, not the UTC day", async () => {
    // 2026-08-16T22:00:00-05:00 Central == 2026-08-17T03:00:00Z UTC — a
    // naive UTC-day read would land this on 2026-08-17 instead of 2026-08-16.
    const fixture = [acuityAppointmentFixture({ date: "August 16, 2026", datetime: "2026-08-16T22:00:00-0500" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-16", "2026-08-23");

    expect(result.appointments).toEqual([{ date: "2026-08-16", appointmentTypeId: 111, vaccineNames: [] }]);
  });

  it("assigns an appointment right at 11:45pm Central to the Central day, even though it's after midnight UTC", async () => {
    // 2026-08-16T23:45:00-05:00 Central == 2026-08-17T04:45:00Z UTC.
    const fixture = [acuityAppointmentFixture({ date: "August 16, 2026", datetime: "2026-08-16T23:45:00-0500" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-16", "2026-08-23");

    expect(result.appointments).toEqual([{ date: "2026-08-16", appointmentTypeId: 111, vaccineNames: [] }]);
  });

  it("flags possiblyTruncated when the response hits the 100-row max cap", async () => {
    const fixture = Array.from({ length: 100 }, (_, i) => acuityAppointmentFixture({ id: i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result.possiblyTruncated).toBe(true);
    expect(result.appointments).toHaveLength(100);
  });

  it("does not flag possiblyTruncated when the response is under the cap", async () => {
    const fixture = Array.from({ length: 99 }, (_, i) => acuityAppointmentFixture({ id: i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result.possiblyTruncated).toBe(false);
  });

  it("throws AcuityApiError on a non-ok response without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    await expect(fetchAppointmentsForRange("user-1", "super-secret", "2026-08-17", "2026-08-24")).rejects.toThrow(
      /rejected these credentials/i
    );
  });

  it("skips malformed entries (missing/invalid datetime or non-numeric type id)", async () => {
    const fixture = [
      acuityAppointmentFixture({ datetime: undefined }),
      acuityAppointmentFixture({ datetime: "not-a-real-datetime" }),
      acuityAppointmentFixture({ appointmentTypeID: "not-a-number" }),
      acuityAppointmentFixture({ date: "August 19, 2026", datetime: "2026-08-19T09:00:00-0500", appointmentTypeID: 222 }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result.appointments).toEqual([{ date: "2026-08-19", appointmentTypeId: 222, vaccineNames: [] }]);
  });
});

describe("fetchAppointmentTypes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only {id, name}", async () => {
    const fixture = [
      { id: 111, name: "Flu Shot", price: "35.00", description: "Annual flu vaccine" },
      { id: 222, name: "COVID Booster", price: "0.00" },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentTypes("user-1", "key-1");

    expect(result).toEqual([
      { id: 111, name: "Flu Shot" },
      { id: 222, name: "COVID Booster" },
    ]);
  });
});

describe("aggregateAppointmentCounts", () => {
  it("falls back to the appointment type's name, grouped by date + name, when vaccineNames is empty", () => {
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [] },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [] },
      { date: "2026-08-17", appointmentTypeId: 222, vaccineNames: [] },
      { date: "2026-08-18", appointmentTypeId: 111, vaccineNames: [] },
    ];
    const names = new Map([
      [111, "Flu Shot"],
      [222, "COVID Booster"],
    ]);

    const result = aggregateAppointmentCounts(appointments, names);

    // Sorted by date, then vaccineName (alphabetical) — "COVID Booster"
    // sorts before "Flu Shot" within the same day.
    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID Booster", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu Shot", count: 2 },
      { date: "2026-08-18", vaccineName: "Flu Shot", count: 1 },
    ]);
  });

  it("falls back to a generic label when the type id has no matching name", () => {
    const result = aggregateAppointmentCounts(
      [{ date: "2026-08-17", appointmentTypeId: 999, vaccineNames: [] }],
      new Map()
    );

    expect(result).toEqual([{ date: "2026-08-17", vaccineName: "Type 999", count: 1 }]);
  });

  it("groups by each of an appointment's vaccineNames, ignoring appointmentTypeId entirely, when present", () => {
    // A single appointment whose form answer lists two vaccines counts
    // once toward EACH vaccine's column, per Will: "a patient getting
    // both Flu and COVID-Pfizer" in one visit.
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu", "COVID-Pfizer"] },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu"] },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID-Pfizer", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu", count: 2 },
    ]);
  });

  it("never emits PHI keys even if a caller (incorrectly) passed extra fields through", () => {
    // aggregateAppointmentCounts only ever destructures {date,
    // appointmentTypeId, vaccineNames} off each input — extra fields on
    // the input object must not leak into output.
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], firstName: "Jane", email: "jane@example.com" },
    ] as unknown as { date: string; appointmentTypeId: number; vaccineNames: string[] }[];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(Object.keys(result[0])).toEqual(["date", "vaccineName", "count"]);
  });
});
