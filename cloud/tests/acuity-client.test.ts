import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
  isAgeFormFieldName,
  isCovidBrandFormFieldName,
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

  it("strips every field down to {date, appointmentTypeId, vaccineNames, covidBrand, covidAgeBucket} — no PHI keys survive", async () => {
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
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
      { date: "2026-08-18", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
    ]);

    // No raw age/DOB field name survives either — the PHI keys list here
    // plus the exact-key assertion below cover both the general PHI
    // fields and the age/DOB boundary specifically (see
    // CountableAppointment's covidAgeBucket doc comment).
    const phiKeys = ["firstName", "lastName", "phone", "email", "notes", "forms", "id", "time", "dob", "age"];
    for (const entry of result.appointments) {
      for (const key of phiKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }
      expect(Object.keys(entry).sort()).toEqual(
        ["appointmentTypeId", "covidAgeBucket", "covidBrand", "date", "vaccineNames"].sort()
      );
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

      expect(result.appointments).toEqual([
        { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu"], covidBrand: "any", covidAgeBucket: "unknown" },
      ]);
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
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          vaccineNames: ["COVID-Pfizer", "Flu", "RSV"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
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
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          vaccineNames: ["Flu", "COVID-Moderna"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
        {
          date: "2026-08-18",
          appointmentTypeId: 111,
          vaccineNames: ["Flu", "RSV"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
        },
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

      expect(result.appointments).toEqual([
        { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
      ]);
    });

    it("falls back to an empty vaccineNames list when the account has no forms at all", async () => {
      const fixture = [acuityAppointmentFixture({ forms: undefined })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([
        { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
      ]);
    });
  });

  // V-T-schedule-table (Will, 2026-09-04): covidBrand/covidAgeBucket are
  // BUCKETED-only derived fields — see CountableAppointment's doc comment.
  // These tests go through the full fetchAppointmentsForRange projection
  // (rather than testing a private helper directly) specifically to prove
  // the raw age/DOB/brand answer text never survives onto the returned
  // appointment, same rationale as the "no PHI keys survive" test above.
  describe("covidBrand / covidAgeBucket derivation", () => {
    function fixtureWithForms(fields: Array<{ name: string; value: string }>) {
      return acuityAppointmentFixture({
        forms: [{ id: 1, name: "Intake", values: fields.map((f, i) => ({ fieldID: i, ...f })) }],
      });
    }

    it("buckets brand: contains 'pfizer' -> pfizer", async () => {
      const fixture = [fixtureWithForms([{ name: "Brand preference", value: "Pfizer" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidBrand).toBe("pfizer");
    });

    it("buckets brand: contains 'moderna' -> moderna", async () => {
      const fixture = [fixtureWithForms([{ name: "Brand preference", value: "I'd like Moderna please" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidBrand).toBe("moderna");
    });

    it("buckets brand as 'any' when the answer names neither manufacturer, or the field is missing", async () => {
      const withOther = [fixtureWithForms([{ name: "Brand preference", value: "No preference" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(withOther), { status: 200 })));
      const result1 = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(result1.appointments[0].covidBrand).toBe("any");
      vi.unstubAllGlobals();

      const withoutField = [acuityAppointmentFixture()];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(withoutField), { status: 200 })));
      const result2 = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(result2.appointments[0].covidBrand).toBe("any");
    });

    it("buckets a plain numeric age into 3-11 or 12+", async () => {
      const childFixture = [fixtureWithForms([{ name: "Patient age", value: "7" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(childFixture), { status: 200 })));
      const childResult = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(childResult.appointments[0].covidAgeBucket).toBe("3-11");
      vi.unstubAllGlobals();

      const adultFixture = [fixtureWithForms([{ name: "Patient age", value: "45" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(adultFixture), { status: 200 })));
      const adultResult = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(adultResult.appointments[0].covidAgeBucket).toBe("12+");
    });

    // Exact boundary coverage for bucketAge: 2 (just below 3-11), 3 and 11
    // (the 3-11 edges), 12 (the highest-risk boundary — the 12th
    // birthday, where a patient becomes 12+-eligible for Pfizer per
    // pharmacy stocking), 110 (the top of 12+), and 111 (just over the
    // >110 -> unknown cutoff).
    it("buckets the exact age boundaries correctly: 2->unknown, 3 and 11->3-11, 12 and 110->12+, 111->unknown", async () => {
      const boundaryAges = [2, 3, 11, 12, 110, 111];
      const fixture = boundaryAges.map((age) => fixtureWithForms([{ name: "Age", value: String(age) }]));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments.map((a) => a.covidAgeBucket)).toEqual([
        "unknown", // 2
        "3-11", // 3
        "3-11", // 11
        "12+", // 12
        "12+", // 110
        "unknown", // 111
      ]);
    });

    it("computes age from a parseable date of birth", async () => {
      const now = new Date();
      // Exactly 8 years old today (or turning 8 today) -> "3-11".
      const dob = `${now.getFullYear() - 8}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const fixture = [fixtureWithForms([{ name: "Date of birth", value: dob }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("3-11");
    });

    // The 12th-birthday boundary specifically, computed from a DOB rather
    // than a plain numeric age — this is the highest-risk spot in
    // computeAgeFromDob's month/day off-by-one adjustment (a patient
    // whose birthday is today has already turned 12; one whose birthday
    // is tomorrow has not).
    it("computes the 12th-birthday DOB boundary correctly: birthday today -> 12+, birthday tomorrow -> still 3-11", async () => {
      const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      // Birthday is exactly today, 12 years ago -> already 12.
      const dobBirthdayToday = isoDate(new Date(now.getFullYear() - 12, now.getMonth(), now.getDate()));
      const fixtureToday = [fixtureWithForms([{ name: "Date of birth", value: dobBirthdayToday }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtureToday), { status: 200 })));
      const resultToday = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(resultToday.appointments[0].covidAgeBucket).toBe("12+");
      vi.unstubAllGlobals();

      // Birthday is tomorrow, 12 years ago from tomorrow -> still 11 today.
      const dobBirthdayTomorrow = isoDate(new Date(tomorrow.getFullYear() - 12, tomorrow.getMonth(), tomorrow.getDate()));
      const fixtureTomorrow = [fixtureWithForms([{ name: "Date of birth", value: dobBirthdayTomorrow }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtureTomorrow), { status: 200 })));
      const resultTomorrow = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(resultTomorrow.appointments[0].covidAgeBucket).toBe("3-11");
    });

    it("buckets age >110 as unknown, per Will's spec, rather than a bogus 12+", async () => {
      const fixture = [fixtureWithForms([{ name: "Age", value: "150" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
    });

    it("buckets an unparseable age answer as unknown", async () => {
      const fixture = [fixtureWithForms([{ name: "Age", value: "not a number or date" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
    });

    it("buckets a missing age field as unknown", async () => {
      const fixture = [acuityAppointmentFixture()];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
    });

    it("never lets the raw age/DOB/brand answer text survive onto the returned appointment", async () => {
      const fixture = [
        fixtureWithForms([
          { name: "Brand preference", value: "Moderna" },
          { name: "Date of birth", value: "1990-01-01" },
        ]),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(Object.keys(result.appointments[0]).sort()).toEqual(
        ["appointmentTypeId", "covidAgeBucket", "covidBrand", "date", "vaccineNames"].sort()
      );
      expect(JSON.stringify(result.appointments[0])).not.toContain("1990-01-01");
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

  // V-T-schedule-table (Will, 2026-09-04): split the COVID column by brand
  // preference and age band, sourced from separate intake-form questions.
  describe("isCovidBrandFormFieldName", () => {
    it("matches field names containing 'brand'", () => {
      expect(isCovidBrandFormFieldName("COVID brand preference")).toBe(true);
      expect(isCovidBrandFormFieldName("Brand")).toBe(true);
      expect(isCovidBrandFormFieldName("BRAND PREFERENCE")).toBe(true);
    });

    it("matches a field mentioning both 'pfizer' and 'moderna' even without the word 'brand'", () => {
      expect(isCovidBrandFormFieldName("Pfizer or Moderna?")).toBe(true);
    });

    it("does not match unrelated field names, or a field naming only one manufacturer", () => {
      expect(isCovidBrandFormFieldName("Insurance provider")).toBe(false);
      expect(isCovidBrandFormFieldName("Which vaccine(s) are you receiving?")).toBe(false);
      expect(isCovidBrandFormFieldName("Pfizer consent")).toBe(false);
      expect(isCovidBrandFormFieldName("")).toBe(false);
    });
  });

  describe("isAgeFormFieldName", () => {
    it("matches 'age' as a whole word, case-insensitively", () => {
      expect(isAgeFormFieldName("Age")).toBe(true);
      expect(isAgeFormFieldName("Patient age")).toBe(true);
      expect(isAgeFormFieldName("AGE")).toBe(true);
    });

    it("matches date-of-birth phrasing", () => {
      expect(isAgeFormFieldName("Date of birth")).toBe(true);
      expect(isAgeFormFieldName("DOB")).toBe(true);
      expect(isAgeFormFieldName("Birth date")).toBe(true);
    });

    it("does not false-positive on words that merely contain the substring 'age'", () => {
      // "average" and "package" both contain "age" as a substring but not
      // as a whole word — a naive .includes("age") would wrongly match.
      expect(isAgeFormFieldName("Average wait time")).toBe(false);
      expect(isAgeFormFieldName("Package label")).toBe(false);
    });

    it("does not match unrelated field names", () => {
      expect(isAgeFormFieldName("Insurance provider")).toBe(false);
      expect(isAgeFormFieldName("")).toBe(false);
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

    expect(result.appointments).toEqual([
      { date: "2026-08-16", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
    ]);
  });

  it("assigns an appointment right at 11:45pm Central to the Central day, even though it's after midnight UTC", async () => {
    // 2026-08-16T23:45:00-05:00 Central == 2026-08-17T04:45:00Z UTC.
    const fixture = [acuityAppointmentFixture({ date: "August 16, 2026", datetime: "2026-08-16T23:45:00-0500" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-16", "2026-08-23");

    expect(result.appointments).toEqual([
      { date: "2026-08-16", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
    ]);
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

    expect(result.appointments).toEqual([
      { date: "2026-08-19", appointmentTypeId: 222, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" },
    ]);
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
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
      { date: "2026-08-17", appointmentTypeId: 222, vaccineNames: [], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
      { date: "2026-08-18", appointmentTypeId: 111, vaccineNames: [], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
    ];
    const names = new Map([
      [111, "Flu Shot"],
      [222, "COVID Booster"],
    ]);

    const result = aggregateAppointmentCounts(appointments, names);

    // Sorted by date, then vaccineName (alphabetical) — "COVID · Any ·
    // Unknown" sorts before "Flu Shot" within the same day. The fallback
    // appointment-type name "COVID Booster" is itself COVID-ish (contains
    // "covid"), so it's rewritten to the brand/age composite too — same
    // rule as a vaccine-name-form-derived COVID name (V-T-schedule-table).
    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu Shot", count: 2 },
      { date: "2026-08-18", vaccineName: "Flu Shot", count: 1 },
    ]);
  });

  it("falls back to a generic label when the type id has no matching name", () => {
    const result = aggregateAppointmentCounts(
      [{ date: "2026-08-17", appointmentTypeId: 999, vaccineNames: [], covidBrand: "any", covidAgeBucket: "unknown" }],
      new Map()
    );

    expect(result).toEqual([{ date: "2026-08-17", vaccineName: "Type 999", count: 1 }]);
  });

  it("groups by each of an appointment's vaccineNames, ignoring appointmentTypeId entirely, when present", () => {
    // A single appointment whose form answer lists two vaccines counts
    // once toward EACH vaccine's column, per Will: "a patient getting
    // both Flu and COVID-Pfizer" in one visit. The COVID entry is
    // rewritten to its brand/age composite using THIS appointment's own
    // covidBrand/covidAgeBucket (V-T-schedule-table, Will 2026-09-04).
    const appointments = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        vaccineNames: ["Flu", "COVID-Pfizer"],
        covidBrand: "pfizer" as const,
        covidAgeBucket: "12+" as const,
      },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["Flu"], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Pfizer · 12+", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu", count: 2 },
    ]);
  });

  it("never emits PHI keys even if a caller (incorrectly) passed extra fields through", () => {
    // aggregateAppointmentCounts only ever destructures {date,
    // appointmentTypeId, vaccineNames, covidBrand, covidAgeBucket} off
    // each input — extra fields on the input object must not leak into
    // output.
    const appointments = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        vaccineNames: [],
        covidBrand: "any",
        covidAgeBucket: "unknown",
        firstName: "Jane",
        email: "jane@example.com",
      },
    ] as unknown as { date: string; appointmentTypeId: number; vaccineNames: string[]; covidBrand: "any"; covidAgeBucket: "unknown" }[];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(Object.keys(result[0])).toEqual(["date", "vaccineName", "count"]);
  });

  it("splits COVID appointments into separate composite columns per (brand, age bucket), including brand match case-insensitively", () => {
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["covid"], covidBrand: "pfizer" as const, covidAgeBucket: "12+" as const },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["COVID"], covidBrand: "moderna" as const, covidAgeBucket: "3-11" as const },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["COVID"], covidBrand: "moderna" as const, covidAgeBucket: "3-11" as const },
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["COVID"], covidBrand: "any" as const, covidAgeBucket: "unknown" as const },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 },
      { date: "2026-08-17", vaccineName: "COVID · Moderna · 3-11", count: 2 },
      { date: "2026-08-17", vaccineName: "COVID · Pfizer · 12+", count: 1 },
    ]);
  });

  it("does not hide a Pfizer 3-11 appointment even though the pharmacy doesn't stock it — renders its own composite column", () => {
    // Will, V-T-schedule-table: "Pfizer with age 3-11 shouldn't happen ...
    // do NOT hide it — render it as its own column if it ever appears."
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, vaccineNames: ["COVID-Pfizer"], covidBrand: "pfizer" as const, covidAgeBucket: "3-11" as const },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([{ date: "2026-08-17", vaccineName: "COVID · Pfizer · 3-11", count: 1 }]);
  });
});
