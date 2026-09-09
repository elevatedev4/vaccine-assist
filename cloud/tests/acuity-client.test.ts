import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateAppointmentCounts,
  aggregateHourlyCounts,
  aggregateTestCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
  isAgeFormFieldName,
  isCovidBrandFormFieldName,
  isTestFormFieldName,
  isVaccineFormFieldName,
  testAcuityConnection,
  ACUITY_APPOINTMENTS_MAX,
  REQUESTS_PER_RANGE_BUDGET,
  type CountableAppointment,
} from "@/lib/acuity-client";
import { addDaysToChicagoDate } from "@/lib/chicago-date";

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
    // V-T-booking-activity: the raw `datetimeCreated` field Acuity's real
    // appointments endpoint returns alongside `datetime` — same ISO 8601
    // + UTC-offset shape, timestamping when the booking was MADE, not the
    // appointment itself. Deliberately a different calendar day than
    // `datetime` above (Aug 10 vs Aug 17) so every assertion using this
    // default proves createdDate and date are derived independently, not
    // accidentally aliasing the same field.
    datetimeCreated: "2026-08-10T09:00:00-0500",
    appointmentTypeID: 111,
    notes: "Allergic to eggs",
    forms: [{ id: 1, name: "Intake", values: [] }],
    ...overrides,
  };
}

// Every appointment lacking an explicit age/brand form field buckets to
// this default, and every appointment using the fixture's default
// datetimeCreated (2026-08-10) resolves to this createdDate — used
// throughout to avoid repeating the same 4 fields on every fixture
// expectation below.
const DEFAULT_BUCKETS = {
  covidBrand: "any",
  covidAgeBucket: "unknown",
  fluAgeBucket: "unknown",
  createdDate: "2026-08-10",
  // V-T-poc-testing: every fixture below uses acuityAppointmentFixture()'s
  // default (no `type` field, no "Select tests:" form field), so
  // testNames is always [] unless a test explicitly overrides forms/type
  // to exercise the point-of-care testing extraction itself (see the
  // "point-of-care test extraction" describe block further down).
  testNames: [] as string[],
} as const;

describe("fetchAppointmentsForRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips every field down to {date, hourOfDay, appointmentTypeId, vaccineNames, covidBrand, covidAgeBucket, fluAgeBucket, createdDate} — no PHI keys survive", async () => {
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
      { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
      { date: "2026-08-18", hourOfDay: 9, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
    ]);

    // No raw age/DOB field name survives either — the PHI keys list here
    // plus the exact-key assertion below cover both the general PHI
    // fields and the age/DOB boundary specifically (see
    // CountableAppointment's covidAgeBucket/fluAgeBucket doc comments).
    // "datetimeCreated" is included too (V-T-booking-activity) — only its
    // bucketed derivative `createdDate` may survive, never the raw field.
    const phiKeys = [
      "firstName",
      "lastName",
      "phone",
      "email",
      "notes",
      "forms",
      "id",
      "time",
      "dob",
      "age",
      "datetimeCreated",
    ];
    for (const entry of result.appointments) {
      for (const key of phiKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }
      expect(Object.keys(entry).sort()).toEqual(
        [
          "appointmentTypeId",
          "covidAgeBucket",
          "covidBrand",
          "createdDate",
          "date",
          "fluAgeBucket",
          "hourOfDay",
          "testNames",
          "vaccineNames",
        ].sort()
      );
    }
  });

  // V-T-hourly-table (Will, 2026-09-05): hourOfDay is derived from the
  // SAME `datetime` instant as `date`, via chicago-date.ts's chicagoHour
  // — not a second independent field.
  describe("hourOfDay derivation", () => {
    it("derives the America/Chicago hour from datetime, independent of the UTC offset", async () => {
      const fixture = [acuityAppointmentFixture({ datetime: "2026-08-17T14:30:00-0500" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toHaveLength(1);
      expect(result.appointments[0].hourOfDay).toBe(14);
    });

    it("is DST-safe (America/Chicago, not a fixed UTC offset)", async () => {
      // 2026-01-15T14:00:00-0600 (CST, winter) and 2026-08-17T14:00:00-0500
      // (CDT, summer) are both "2:00pm Central" — both must bucket to hour
      // 14 even though their UTC offsets differ.
      const fixture = [
        acuityAppointmentFixture({ id: 1, datetime: "2026-01-15T14:00:00-0600" }),
        acuityAppointmentFixture({ id: 2, datetime: "2026-08-17T14:00:00-0500" }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-01-01", "2026-12-31");

      expect(result.appointments.map((a) => a.hourOfDay)).toEqual([14, 14]);
    });
  });

  // V-T-booking-activity (Will, 2026-09-05/07): createdDate is derived from
  // `datetimeCreated` via the SAME acuityDatetimeToChicagoDate helper as
  // `date` is derived from `datetime` — these tests mirror the "10pm
  // Central" / "11:45pm Central" boundary tests further down for `date`,
  // proving the SAME Chicago-day boundary correctness applies to
  // `createdDate` independently, not just to the appointment day.
  describe("createdDate derivation", () => {
    it("derives createdDate from datetimeCreated, independent of the appointment's own datetime", async () => {
      const fixture = [
        acuityAppointmentFixture({
          datetime: "2026-08-17T10:00:00-0500",
          datetimeCreated: "2026-07-30T08:15:00-0500",
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toHaveLength(1);
      expect(result.appointments[0].date).toBe("2026-08-17");
      expect(result.appointments[0].createdDate).toBe("2026-07-30");
    });

    // Reproduces the same class of bug the `date` boundary tests below
    // guard against: a booking made late at night Central must land on
    // the Central calendar day it was actually made, not the UTC day a
    // naive `datetimeCreated.slice(0, 10)` read would produce.
    // 2026-08-16T22:00:00-05:00 Central == 2026-08-17T03:00:00Z UTC — a
    // naive UTC-day read would wrongly put this booking on 2026-08-17.
    it("assigns a booking made at 10pm Central to the Central calendar day the booking was made, not the UTC day", async () => {
      const fixture = [
        acuityAppointmentFixture({
          datetime: "2026-08-20T10:00:00-0500",
          datetimeCreated: "2026-08-16T22:00:00-0500",
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].createdDate).toBe("2026-08-16");
    });

    // The other side of the same boundary: a booking made right at
    // 11:45pm Central (2026-08-16T23:45:00-05:00 Central ==
    // 2026-08-17T04:45:00Z UTC) is still 2026-08-16 in Chicago, even
    // though it's already past midnight UTC.
    it("assigns a booking made at 11:45pm Central to the Central day, even though it's after midnight UTC", async () => {
      const fixture = [
        acuityAppointmentFixture({
          datetime: "2026-08-20T10:00:00-0500",
          datetimeCreated: "2026-08-16T23:45:00-0500",
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].createdDate).toBe("2026-08-16");
    });

    it("is DST-safe (America/Chicago, not a fixed UTC offset), same as date/hourOfDay", async () => {
      const fixture = [
        acuityAppointmentFixture({ id: 1, datetimeCreated: "2026-01-15T23:30:00-0600" }), // CST, winter
        acuityAppointmentFixture({ id: 2, datetimeCreated: "2026-08-17T23:30:00-0500" }), // CDT, summer
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-01-01", "2026-12-31");

      expect(result.appointments.map((a) => a.createdDate)).toEqual(["2026-01-15", "2026-08-17"]);
    });

    it("falls back to \"\" when datetimeCreated is missing or unparseable, without dropping the appointment", async () => {
      const fixture = [
        acuityAppointmentFixture({ datetimeCreated: undefined }),
        acuityAppointmentFixture({ id: 2, datetimeCreated: "not-a-real-datetime" }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toHaveLength(2);
      expect(result.appointments.map((a) => a.createdDate)).toEqual(["", ""]);
      // Still fully valid on every other field — a bad/missing
      // createdDate never disqualifies the appointment itself, only a
      // createdDate-keyed aggregation (lib/acuity-booking-activity.ts)
      // filters these out.
      expect(result.appointments[0].date).toBe("2026-08-17");
    });
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
        { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: ["Flu"], ...DEFAULT_BUCKETS },
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
          hourOfDay: 10,
          appointmentTypeId: 111,
          vaccineNames: ["COVID-Pfizer", "Flu", "RSV"],
          ...DEFAULT_BUCKETS,
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
          hourOfDay: 10,
          appointmentTypeId: 111,
          vaccineNames: ["Flu", "COVID-Moderna"],
          ...DEFAULT_BUCKETS,
        },
        {
          date: "2026-08-18",
          hourOfDay: 9,
          appointmentTypeId: 111,
          vaccineNames: ["Flu", "RSV"],
          ...DEFAULT_BUCKETS,
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
        { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
      ]);
    });

    it("falls back to an empty vaccineNames list when the account has no forms at all", async () => {
      const fixture = [acuityAppointmentFixture({ forms: undefined })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments).toEqual([
        { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
      ]);
    });
  });

  // V-T-poc-testing (Will, 2026-09-08): point-of-care test names, mirroring
  // the vaccine name extraction tests above — form-field extraction is the
  // primary path, the appointment TYPE name's own parenthetical is the
  // fallback ONLY when no form field matches. Field name/values ("Select
  // tests:" / "COVID (free)" / "Strep Throat") are exactly what the
  // live-probe evidence (2026-09-08) found — see isTestFormFieldName's doc
  // comment in lib/acuity-client.ts.
  describe("point-of-care test extraction", () => {
    it("extracts test names from a form field matching 'test' (case-insensitive), stripping a trailing price qualifier", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment (Flu, COVID, Strep)",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: "COVID (free)" }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID"]);
    });

    it("splits a comma-separated multi-test answer into individual trimmed, qualifier-stripped names", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment (Flu, COVID, Strep)",
          forms: [
            { id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: "COVID (free), Strep Throat" }] },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID", "Strep Throat"]);
    });

    it("falls back to parsing the appointment type name's parenthetical when no form field matches", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment (Flu, COVID, Strep)",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Insurance provider", value: "Acme Health" }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["Flu", "COVID", "Strep"]);
    });

    it("falls back to an empty testNames list when neither a form field nor a parenthetical type name is present", async () => {
      const fixture = [acuityAppointmentFixture({ type: "Flu Shot" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual([]);
    });

    it("never lets a form field's raw answer text leak — only the extracted/bucketed testNames survive", async () => {
      // Same PHI-boundary proof style as the "no PHI keys survive" test
      // above: a vaccine appointment's OWN unrelated fields (name/email)
      // must never appear, and the appointment TYPE's raw `type` string
      // itself (read only as the fallback SOURCE, never stored) must not
      // survive onto the returned appointment either.
      const fixture = [acuityAppointmentFixture({ type: "Test appointment (Flu, COVID, Strep)" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(Object.prototype.hasOwnProperty.call(result.appointments[0], "type")).toBe(false);
      expect(result.appointments[0].testNames).toEqual(["Flu", "COVID", "Strep"]);
    });

    // Security review (2026-09-08, REQUEST_CHANGES — blocking, adversarial
    // cases): a genuine SCREENING question's free-text answer must NEVER
    // become a testName, even end-to-end through fetchAppointmentsForRange
    // — this is the exact PHI-leak scenario the review flagged (a
    // screening answer riding into testNames -> the point-of-care test
    // table -> a cache row -> a rendered column header).
    it("never extracts a screening question's free-text answer as a testName", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Flu Shot",
          forms: [
            {
              id: 1,
              name: "Intake",
              values: [
                { fieldID: 9, name: "Have you had a positive COVID test recently?", value: "yes, last week at home" },
              ],
            },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual([]);
    });

    // V-T27 (Will, 2026-09-09 verbatim: "Make sure the test appointment
    // data is coming through (which test they want to receive from the
    // intake questions)" — the Tests column was showing "COVID" for only
    // SOME rows). The three fixtures below are the shapes that were being
    // dropped before this round: a QUESTION-style field label (answer as
    // the value), a checkbox field whose value comes back as an ARRAY
    // instead of a joined string, and a test named directly in the
    // appointment TYPE with no parenthetical breakdown at all.
    it("extracts a test name from a QUESTION-style field label ('Which test would you like?') with the answer as the value", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Which test would you like?", value: "COVID" }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID"]);
    });

    it("extracts every test from a multi-select QUESTION-style field's comma-joined answer", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment",
          forms: [
            {
              id: 1,
              name: "Intake",
              values: [{ fieldID: 9, name: "What tests would you like to receive?", value: "COVID, Strep" }],
            },
          ],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID", "Strep"]);
    });

    it("extracts every test from a checkbox field whose value is an ARRAY of selected options, not a joined string", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Test appointment",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: ["COVID", "Strep Throat"] }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID", "Strep Throat"]);
    });

    it("ignores a checkbox array value with a non-string entry rather than guessing at it", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "Flu Shot",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: ["COVID", { weird: true }] }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual([]);
    });

    it("extracts a single test name from a plain appointment TYPE name with no parenthetical ('COVID Test')", async () => {
      const fixture = [acuityAppointmentFixture({ type: "COVID Test" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["COVID"]);
    });

    it("extracts a single test name from a plain appointment TYPE name ending in 'Testing'", async () => {
      const fixture = [acuityAppointmentFixture({ type: "Strep Testing" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["Strep"]);
    });

    it("does NOT extract a test name from a vaccine type that merely mentions testing in passing ('COVID Vaccine + Test Visit')", async () => {
      const fixture = [acuityAppointmentFixture({ type: "COVID Vaccine + Test Visit" })];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual([]);
    });

    it("still prefers a form field's testNames over the plain-type-name fallback when both are present", async () => {
      const fixture = [
        acuityAppointmentFixture({
          type: "COVID Test",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: "Strep" }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual(["Strep"]);
    });

    it("drops a value from a genuinely-named 'Select tests:' field when it's a long free-text answer instead of a short multi-select choice", async () => {
      // Well over the 40-char allowlist cap (lib/acuity-client.ts's
      // MAX_TEST_VALUE_LENGTH) — the exact length doesn't matter, only
      // that it's unambiguously too long to be a real multi-select answer.
      const longFreeTextAnswer =
        "I went to urgent care last Tuesday and they said it might be strep but the rapid test was inconclusive so they sent a culture.";
      expect(longFreeTextAnswer.length).toBeGreaterThan(40);
      const fixture = [
        acuityAppointmentFixture({
          // Deliberately NO parenthetical on the type name (unlike the
          // other tests in this block) — this isolates the assertion to
          // "the over-length value itself was dropped," rather than
          // letting the type-name-parenthetical fallback (which fires
          // whenever the form-field path finds nothing at all) mask a
          // regression by recovering testNames a different way.
          type: "Test appointment",
          forms: [{ id: 1, name: "Intake", values: [{ fieldID: 9, name: "Select tests:", value: longFreeTextAnswer }] }],
        }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].testNames).toEqual([]);
    });
  });

  describe("isTestFormFieldName", () => {
    it("matches the real Acuity field name, case-insensitively, regardless of the trailing colon", () => {
      expect(isTestFormFieldName("Select tests:")).toBe(true);
      expect(isTestFormFieldName("select TESTS:")).toBe(true);
      expect(isTestFormFieldName("Select tests")).toBe(true);
      expect(isTestFormFieldName("Select test:")).toBe(true);
    });

    it("does not match unrelated field names", () => {
      expect(isTestFormFieldName("Which vaccine(s) are you receiving?")).toBe(false);
      expect(isTestFormFieldName("Insurance provider")).toBe(false);
      expect(isTestFormFieldName("")).toBe(false);
    });

    // Security review (2026-09-08, REQUEST_CHANGES — blocking): the OLD
    // bare .includes("test") heuristic also matched genuine SCREENING
    // questions, whose free-text ANSWER could be real patient health
    // information — this must be false now that the match is an
    // allowlist, not a substring.
    it("does not match a screening question that merely mentions 'test'", () => {
      expect(isTestFormFieldName("Have you had a positive COVID test recently?")).toBe(false);
      expect(isTestFormFieldName("Any test results we should know about?")).toBe(false);
    });

    // V-T27 (Will, 2026-09-09): a real Acuity form can phrase the test
    // selection as a QUESTION ("Which test would you like?") rather than
    // the "Select tests:" label the original live probe found — this WAS
    // dropped entirely (see the superseded assertion this replaces, git
    // blame) until this round; now matched via
    // TEST_SELECTION_QUESTION_PATTERN. isAllowedTestValue (see the
    // "point-of-care test extraction" describe block above) is still the
    // deciding second layer on the VALUE either way.
    it("matches a forward-looking selection question ('which'/'what' + 'test(s)')", () => {
      expect(isTestFormFieldName("Which test would you like?")).toBe(true);
      expect(isTestFormFieldName("Which tests would you like to receive?")).toBe(true);
      expect(isTestFormFieldName("What test are you here for?")).toBe(true);
    });

    it("still does not match an unrelated 'which' question that never mentions test(s)", () => {
      expect(isTestFormFieldName("Which vaccine(s) are you receiving?")).toBe(false);
      expect(isTestFormFieldName("Which location would you like?")).toBe(false);
    });
  });

  // V-T-schedule-table (Will, 2026-09-04/05): covidBrand/covidAgeBucket/
  // fluAgeBucket are BUCKETED-only derived fields — see
  // CountableAppointment's doc comment. These tests go through the full
  // fetchAppointmentsForRange projection (rather than testing a private
  // helper directly) specifically to prove the raw age/DOB/brand answer
  // text never survives onto the returned appointment, same rationale as
  // the "no PHI keys survive" test above.
  describe("covidBrand / covidAgeBucket / fluAgeBucket derivation", () => {
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

    it("buckets a plain numeric age into 3-11 or 12-64", async () => {
      const childFixture = [fixtureWithForms([{ name: "Patient age", value: "7" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(childFixture), { status: 200 })));
      const childResult = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(childResult.appointments[0].covidAgeBucket).toBe("3-11");
      vi.unstubAllGlobals();

      const adultFixture = [fixtureWithForms([{ name: "Patient age", value: "45" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(adultFixture), { status: 200 })));
      const adultResult = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(adultResult.appointments[0].covidAgeBucket).toBe("12-64");
    });

    // Exact boundary coverage for bucketCovidAge (V-T-schedule-table
    // ROUND 2, Will 2026-09-05 — a 65+ split was added to every COVID
    // brand, superseding the original 3-11/12+ split from the same day):
    // 2 (just below 3-11, now the shared young-end cutoff with Flu), 3
    // and 11 (the 3-11 edges), 12 and 64 (the 12-64 edges), 65 and 110
    // (the 65+ edges), and 111 (just over the >110 -> unknown cutoff).
    it("buckets the exact COVID age boundaries correctly: 2->unknown, 3&11->3-11, 12&64->12-64, 65&110->65+, 111->unknown", async () => {
      const boundaryAges = [2, 3, 11, 12, 64, 65, 110, 111];
      const fixture = boundaryAges.map((age) => fixtureWithForms([{ name: "Age", value: String(age) }]));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments.map((a) => a.covidAgeBucket)).toEqual([
        "unknown", // 2
        "3-11", // 3
        "3-11", // 11
        "12-64", // 12
        "12-64", // 64
        "65+", // 65
        "65+", // 110
        "unknown", // 111
      ]);
    });

    // Same boundary set for bucketFluAge — Flu has no 3-11/12-64 split,
    // just 3-64/65+/unknown, but shares the same [3, 110] valid range.
    it("buckets the exact Flu age boundaries correctly: 2->unknown, 3&64->3-64, 65&110->65+, 111->unknown", async () => {
      const boundaryAges = [2, 3, 64, 65, 110, 111];
      const fixture = boundaryAges.map((age) => fixtureWithForms([{ name: "Age", value: String(age) }]));
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments.map((a) => a.fluAgeBucket)).toEqual([
        "unknown", // 2
        "3-64", // 3
        "3-64", // 64
        "65+", // 65
        "65+", // 110
        "unknown", // 111
      ]);
    });

    it("computes age from a parseable date of birth, bucketing both covidAgeBucket and fluAgeBucket off the same answer", async () => {
      const now = new Date();
      // Exactly 8 years old today (or turning 8 today) -> COVID "3-11",
      // Flu "3-64" — same underlying age, two independent bucketings.
      const dob = `${now.getFullYear() - 8}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const fixture = [fixtureWithForms([{ name: "Date of birth", value: dob }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("3-11");
      expect(result.appointments[0].fluAgeBucket).toBe("3-64");
    });

    // The 65th-birthday boundary specifically, computed from a DOB rather
    // than a plain numeric age — this is the highest-risk spot in
    // computeAgeFromDob's month/day off-by-one adjustment (a patient
    // whose birthday is today has already turned 65; one whose birthday
    // is tomorrow has not). Covers both bucketCovidAge and bucketFluAge
    // since they share the same 65 cutoff.
    it("computes the 65th-birthday DOB boundary correctly: birthday today -> 65+, birthday tomorrow -> still under 65", async () => {
      const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      // Birthday is exactly today, 65 years ago -> already 65.
      const dobBirthdayToday = isoDate(new Date(now.getFullYear() - 65, now.getMonth(), now.getDate()));
      const fixtureToday = [fixtureWithForms([{ name: "Date of birth", value: dobBirthdayToday }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtureToday), { status: 200 })));
      const resultToday = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(resultToday.appointments[0].covidAgeBucket).toBe("65+");
      expect(resultToday.appointments[0].fluAgeBucket).toBe("65+");
      vi.unstubAllGlobals();

      // Birthday is tomorrow, 65 years ago from tomorrow -> still 64 today.
      const dobBirthdayTomorrow = isoDate(new Date(tomorrow.getFullYear() - 65, tomorrow.getMonth(), tomorrow.getDate()));
      const fixtureTomorrow = [fixtureWithForms([{ name: "Date of birth", value: dobBirthdayTomorrow }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtureTomorrow), { status: 200 })));
      const resultTomorrow = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");
      expect(resultTomorrow.appointments[0].covidAgeBucket).toBe("12-64");
      expect(resultTomorrow.appointments[0].fluAgeBucket).toBe("3-64");
    });

    it("buckets age >110 as unknown, per Will's spec, rather than a bogus 65+", async () => {
      const fixture = [fixtureWithForms([{ name: "Age", value: "150" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
      expect(result.appointments[0].fluAgeBucket).toBe("unknown");
    });

    it("buckets an unparseable age answer as unknown", async () => {
      const fixture = [fixtureWithForms([{ name: "Age", value: "not a number or date" }])];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
      expect(result.appointments[0].fluAgeBucket).toBe("unknown");
    });

    it("buckets a missing age field as unknown", async () => {
      const fixture = [acuityAppointmentFixture()];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

      expect(result.appointments[0].covidAgeBucket).toBe("unknown");
      expect(result.appointments[0].fluAgeBucket).toBe("unknown");
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
        [
          "appointmentTypeId",
          "covidAgeBucket",
          "covidBrand",
          "createdDate",
          "date",
          "fluAgeBucket",
          "hourOfDay",
          "testNames",
          "vaccineNames",
        ].sort()
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
      { date: "2026-08-16", hourOfDay: 22, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
    ]);
  });

  it("assigns an appointment right at 11:45pm Central to the Central day, even though it's after midnight UTC", async () => {
    // 2026-08-16T23:45:00-05:00 Central == 2026-08-17T04:45:00Z UTC.
    const fixture = [acuityAppointmentFixture({ date: "August 16, 2026", datetime: "2026-08-16T23:45:00-0500" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-16", "2026-08-23");

    expect(result.appointments).toEqual([
      { date: "2026-08-16", hourOfDay: 23, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
    ]);
  });

  // MSG-897: a saturated MULTI-day range now recurses/pages instead of
  // stopping here — see the dedicated "chunked pagination" describe block
  // below for that behavior. A single-day range is the recursion FLOOR
  // (can't split a day any further), so it's the simplest case that still
  // exercises the original "hits the cap" signal with exactly one
  // request — a multi-day range against this same always-100 mock would
  // recurse (this mock has no per-window variation to resolve against)
  // and, more immediately, can't: a mocked Response's body can only be
  // read once, so a second `fetch` call reusing the same mockResolvedValue
  // Response would throw.
  it("flags possiblyTruncated when a single day's response hits the max cap", async () => {
    const fixture = Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-17");

    expect(result.possiblyTruncated).toBe(true);
    expect(result.appointments).toHaveLength(ACUITY_APPOINTMENTS_MAX);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not flag possiblyTruncated when the response is under the cap", async () => {
    const fixture = Array.from({ length: ACUITY_APPOINTMENTS_MAX - 1 }, (_, i) => acuityAppointmentFixture({ id: i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result.possiblyTruncated).toBe(false);
  });

  // V-T23 (Will, verbatim): "A single day can absolutely have more than
  // 100 appointments. You'll have to figure out a solution that works for
  // that too." Proves the shipped fix (raising ACUITY_APPOINTMENTS_MAX,
  // see that constant's doc comment for the live-probe evidence) actually
  // resolves the reported case: a single day with MORE than the OLD
  // 100-row cap now fetches complete and unflagged in exactly one
  // request, because the real request now asks for up to
  // ACUITY_APPOINTMENTS_MAX (1000) rows, not 100.
  it("fetches a single day with more than 100 appointments complete and unflagged (V-T23)", async () => {
    const fixture = Array.from({ length: 350 }, (_, i) => acuityAppointmentFixture({ id: i }));
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-17");

    expect(result.possiblyTruncated).toBe(false);
    expect(result.appointments).toHaveLength(350);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchSpy.mock.calls[0][0] as string | URL);
    expect(requestedUrl.searchParams.get("max")).toBe(String(ACUITY_APPOINTMENTS_MAX));
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
      { date: "2026-08-19", hourOfDay: 9, appointmentTypeId: 222, vaccineNames: [], ...DEFAULT_BUCKETS },
    ]);
  });

  // MSG-897 (Will: "the app must be reliable regardless of volume" —
  // "warning stays" isn't the end state when a deterministic workaround
  // exists). These exercise the recursive date-window pagination itself
  // — see fetchAppointmentsForRange's doc comment in lib/acuity-client.ts
  // for the algorithm. Unlike every test above (one static fixture reused
  // for every call, via mockResolvedValue — fine when only one request is
  // ever expected), these use a fake server keyed by the actual
  // minDate/maxDate query params of each request, so recursion behaves
  // realistically and the exact request count/shape can be asserted.
  describe("chunked pagination", () => {
    function fakeAcuityServer(responder: (minDate: string, maxDate: string) => Record<string, unknown>[]) {
      return vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        const minDate = url.searchParams.get("minDate") ?? "";
        const maxDate = url.searchParams.get("maxDate") ?? "";
        return new Response(JSON.stringify(responder(minDate, maxDate)), { status: 200 });
      });
    }

    it("<100 fast path: a non-saturated response completes in exactly one request, even across a multi-day range", async () => {
      const fixture = [1, 2, 3, 4, 5].map((id) => acuityAppointmentFixture({ id }));
      const fetchSpy = fakeAcuityServer(() => fixture);
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-01", "2026-08-14");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.possiblyTruncated).toBe(false);
      expect(result.appointments).toHaveLength(5);
    });

    it("splits a saturated multi-day window in half and recovers the complete count once both halves are under the cap", async () => {
      const fetchSpy = fakeAcuityServer((minDate, maxDate) => {
        if (minDate === "2026-08-01" && maxDate === "2026-08-14") {
          // Top-level probe: saturated — triggers a split. This batch is
          // discarded once the children resolve (see the doc comment on
          // why), so its content doesn't matter, only its length.
          return Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }));
        }
        if (minDate === "2026-08-01" && maxDate === "2026-08-07") {
          return Array.from({ length: 60 }, (_, i) => acuityAppointmentFixture({ id: i }));
        }
        if (minDate === "2026-08-08" && maxDate === "2026-08-14") {
          return Array.from({ length: 55 }, (_, i) => acuityAppointmentFixture({ id: 1000 + i }));
        }
        throw new Error(`unexpected window requested: ${minDate}..${maxDate}`);
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-01", "2026-08-14");

      expect(fetchSpy).toHaveBeenCalledTimes(3); // parent probe + 2 halves
      expect(result.possiblyTruncated).toBe(false); // both halves completed — the parent's saturated probe doesn't count
      expect(result.appointments).toHaveLength(115); // 60 + 55, the COMPLETE count, not the probe's saturated 100
    });

    it("floors recursion at a single day, flagging possiblyTruncated only for that day when it alone still saturates", async () => {
      const fetchSpy = fakeAcuityServer((minDate, maxDate) => {
        if (minDate === "2026-08-01" && maxDate === "2026-08-02") {
          return Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }));
        }
        if (minDate === "2026-08-01" && maxDate === "2026-08-01") {
          // The single saturated day — recursion floor, can't split
          // further, so this IS the residual "may be incomplete" case.
          return Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }));
        }
        if (minDate === "2026-08-02" && maxDate === "2026-08-02") {
          // The other day resolves cleanly, under the cap.
          return Array.from({ length: 10 }, (_, i) => acuityAppointmentFixture({ id: 1000 + i }));
        }
        throw new Error(`unexpected window requested: ${minDate}..${maxDate}`);
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-01", "2026-08-02");

      expect(fetchSpy).toHaveBeenCalledTimes(3); // parent probe + 2 single-day halves
      expect(result.possiblyTruncated).toBe(true); // the one saturated day taints the whole result
      expect(result.appointments).toHaveLength(ACUITY_APPOINTMENTS_MAX + 10); // saturated day, kept anyway + 10 (complete day)
    });

    it("dedupes an appointment id that appears in both halves at a shared window boundary", async () => {
      const fetchSpy = fakeAcuityServer((minDate, maxDate) => {
        if (minDate === "2026-08-01" && maxDate === "2026-08-04") {
          return Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }));
        }
        if (minDate === "2026-08-01" && maxDate === "2026-08-02") {
          return [
            acuityAppointmentFixture({ id: 1 }),
            acuityAppointmentFixture({ id: 2 }),
            acuityAppointmentFixture({ id: 999 }), // boundary appointment
          ];
        }
        if (minDate === "2026-08-03" && maxDate === "2026-08-04") {
          return [
            acuityAppointmentFixture({ id: 999 }), // the SAME id, appearing again
            acuityAppointmentFixture({ id: 3 }),
          ];
        }
        throw new Error(`unexpected window requested: ${minDate}..${maxDate}`);
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-01", "2026-08-04");

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(result.possiblyTruncated).toBe(false);
      expect(result.appointments).toHaveLength(4); // ids 1, 2, 999 (once, not twice), 3
    });

    it("bails out once REQUESTS_PER_RANGE_BUDGET is spent, keeping what was already fetched and flagging possiblyTruncated", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A pathological "never resolves" server — every window, at every
      // granularity, comes back saturated. 64 days supports 6 levels of
      // halving (64 -> 32 -> ... -> 1) before hitting single-day
      // windows, so an UNBOUNDED recursion here would issue far more
      // than REQUESTS_PER_RANGE_BUDGET requests — the budget, not the
      // date range, is what has to stop it.
      const fetchSpy = fakeAcuityServer(() =>
        Array.from({ length: ACUITY_APPOINTMENTS_MAX }, (_, i) => acuityAppointmentFixture({ id: i }))
      );
      vi.stubGlobal("fetch", fetchSpy);

      const start = "2026-08-01";
      const end = addDaysToChicagoDate(start, 63);
      const result = await fetchAppointmentsForRange("user-1", "key-1", start, end);

      expect(fetchSpy).toHaveBeenCalledTimes(REQUESTS_PER_RANGE_BUDGET);
      expect(result.possiblyTruncated).toBe(true);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
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
    const appointments: CountableAppointment[] = [
      { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
      { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
      { date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 222, vaccineNames: [], ...DEFAULT_BUCKETS },
      { date: "2026-08-18", hourOfDay: 10, appointmentTypeId: 111, vaccineNames: [], ...DEFAULT_BUCKETS },
    ];
    const names = new Map([
      [111, "Flu Shot"],
      [222, "COVID Booster"],
    ]);

    const result = aggregateAppointmentCounts(appointments, names);

    // Sorted by date, then vaccineName (alphabetical) — "COVID · Any ·
    // Unknown" sorts before "Flu · Unknown" within the same day. Both
    // fallback appointment-type names ("COVID Booster", "Flu Shot") are
    // themselves COVID-/Flu-ish (contain "covid"/"flu"), so they're
    // rewritten to their brand/age (or age) composite too — same rule as
    // a vaccine-name-form-derived name (V-T-schedule-table).
    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu · Unknown", count: 2 },
      { date: "2026-08-18", vaccineName: "Flu · Unknown", count: 1 },
    ]);
  });

  it("falls back to a generic label when the type id has no matching name", () => {
    const result = aggregateAppointmentCounts(
      [{ date: "2026-08-17", hourOfDay: 10, appointmentTypeId: 999, vaccineNames: [], ...DEFAULT_BUCKETS }] as CountableAppointment[],
      new Map()
    );

    expect(result).toEqual([{ date: "2026-08-17", vaccineName: "Type 999", count: 1 }]);
  });

  // V-T-poc-testing follow-up (manager, 2026-09-08): a point-of-care
  // testing appointment must NEVER count as a vaccine via the type-name
  // fallback above — closing the gap the original point-of-care-testing
  // brief flagged (a test-type appointment's own name, e.g. "Test
  // appointment (Flu, COVID, Strep)", contains "covid" as a substring, so
  // the fallback used to misread it as a COVID vaccine appointment).
  describe("point-of-care testing exclusion from the vaccine table", () => {
    it("excludes an appointment with testNames set and no vaccineNames, even though its fallback type name contains 'covid'", () => {
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 90788212,
          vaccineNames: [],
          ...DEFAULT_BUCKETS,
          testNames: ["COVID"],
        },
      ];
      const names = new Map([[90788212, "Test appointment (Flu, COVID, Strep)"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([]);
    });

    it("excludes an appointment whose type name looks test-ish (starts with 'test appointment') even when testNames itself is empty (no parenthetical, no matching form field)", () => {
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 90788212,
          vaccineNames: [],
          ...DEFAULT_BUCKETS,
          testNames: [],
        },
      ];
      // Security review (2026-09-08): isTestAppointmentTypeName is
      // ALLOWLIST-tightened, not a bare "test" substring match — a name
      // like the OLD test fixture's "COVID Test Visit" no longer matches
      // (see that function's own doc comment for why), so this uses a
      // name that actually satisfies the tightened rule (starts with
      // "test appointment") but has NO parenthetical for
      // parseTestNamesFromAppointmentTypeName to parse — the exact
      // "neither signal fired a testNames value, but the type name alone
      // still says testing" case this test targets.
      const names = new Map([[90788212, "Test Appointment - Walk-in"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([]);
    });

    it("does NOT exclude a vaccine appointment whose type name merely mentions 'test' in passing (tightened isTestAppointmentTypeName, security review 2026-09-08)", () => {
      // The OLD bare-substring heuristic would have wrongly excluded this
      // — a real vaccine appointment must never be silently dropped from
      // its own table just because its name contains the word "test".
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 333,
          vaccineNames: [],
          ...DEFAULT_BUCKETS,
          testNames: [],
        },
      ];
      const names = new Map([[333, "COVID Test Visit"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([{ date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 }]);
    });

    it("does NOT treat a vaccine type named with a parenthetical, e.g. 'Latest vaccines (fall)', as a test type", () => {
      // Adversarial case (security review, 2026-09-08): a parenthetical
      // alone must not be confused with a testing type — only the
      // "starts with 'test appointment'"/"point of care"/"poc" patterns
      // do.
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 444,
          vaccineNames: [],
          ...DEFAULT_BUCKETS,
          testNames: [],
        },
      ];
      const names = new Map([[444, "Latest vaccines (fall)"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([{ date: "2026-08-17", vaccineName: "Latest vaccines (fall)", count: 1 }]);
    });

    it("still falls back to the type name normally for a genuine vaccine-type appointment (regression guard)", () => {
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 111,
          vaccineNames: [],
          ...DEFAULT_BUCKETS,
          testNames: [],
        },
      ];
      const names = new Map([[111, "RSV Vaccine"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([{ date: "2026-08-17", vaccineName: "RSV Vaccine", count: 1 }]);
    });

    it("counts a HYBRID appointment (test type, but with an explicit vaccine form answer) under its vaccineNames normally", () => {
      // A point-of-care testing appointment where the patient ALSO got a
      // vaccine that same visit — the explicit vaccineNames answer always
      // wins, test-type or not (the exclusion rule only applies in the
      // vaccineNames-EMPTY branch).
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          hourOfDay: 10,
          appointmentTypeId: 90788212,
          vaccineNames: ["Flu"],
          testNames: ["COVID"],
          covidBrand: "any",
          covidAgeBucket: "unknown",
          fluAgeBucket: "3-64",
          createdDate: "2026-08-10",
        },
      ];
      const names = new Map([[90788212, "Test appointment (Flu, COVID, Strep)"]]);

      const result = aggregateAppointmentCounts(appointments, names);

      expect(result).toEqual([{ date: "2026-08-17", vaccineName: "Flu · 3-64", count: 1 }]);
    });
  });

  it("groups by each of an appointment's vaccineNames, ignoring appointmentTypeId entirely, when present", () => {
    // A single appointment whose form answer lists two vaccines counts
    // once toward EACH vaccine's column, per Will: "a patient getting
    // both Flu and COVID-Pfizer" in one visit. The COVID entry is
    // rewritten to its brand/age composite using THIS appointment's own
    // covidBrand/covidAgeBucket (V-T-schedule-table, Will 2026-09-04);
    // the Flu entry rides its own fluAgeBucket the same way (ROUND 2).
    const appointments: CountableAppointment[] = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["Flu", "COVID-Pfizer"],
        testNames: [],
        covidBrand: "pfizer" as const,
        covidAgeBucket: "12-64" as const,
        fluAgeBucket: "3-64" as const,
        createdDate: "2026-08-10",
      },
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["Flu"],
        testNames: [],
        covidBrand: "any" as const,
        covidAgeBucket: "unknown" as const,
        fluAgeBucket: "65+" as const,
        createdDate: "2026-08-10",
      },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Pfizer · 12-64", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu · 3-64", count: 1 },
      { date: "2026-08-17", vaccineName: "Flu · 65+", count: 1 },
    ]);
  });

  it("never emits PHI keys even if a caller (incorrectly) passed extra fields through", () => {
    // aggregateAppointmentCounts only ever destructures {date,
    // appointmentTypeId, vaccineNames, testNames, covidBrand,
    // covidAgeBucket, fluAgeBucket} off each input — extra fields on the
    // input object must not leak into output.
    const appointments = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: [],
        testNames: [],
        covidBrand: "any",
        covidAgeBucket: "unknown",
        fluAgeBucket: "unknown",
        createdDate: "2026-08-10",
        firstName: "Jane",
        email: "jane@example.com",
      },
    ] as unknown as {
      date: string;
      appointmentTypeId: number;
      hourOfDay: number;
      vaccineNames: string[];
      testNames: string[];
      covidBrand: "any";
      covidAgeBucket: "unknown";
      fluAgeBucket: "unknown";
      createdDate: string;
    }[];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(Object.keys(result[0])).toEqual(["date", "vaccineName", "count"]);
  });

  it("splits COVID appointments into separate composite columns per (brand, age bucket), including brand match case-insensitively", () => {
    const appointments: CountableAppointment[] = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["covid"],
        testNames: [],
        covidBrand: "pfizer" as const,
        covidAgeBucket: "65+" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      },
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["COVID"],
        testNames: [],
        covidBrand: "moderna" as const,
        covidAgeBucket: "3-11" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      },
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["COVID"],
        testNames: [],
        covidBrand: "moderna" as const,
        covidAgeBucket: "3-11" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      },
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["COVID"],
        testNames: [],
        covidBrand: "any" as const,
        covidAgeBucket: "unknown" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([
      { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 },
      { date: "2026-08-17", vaccineName: "COVID · Moderna · 3-11", count: 2 },
      { date: "2026-08-17", vaccineName: "COVID · Pfizer · 65+", count: 1 },
    ]);
  });

  it("does not hide a Pfizer 3-11 appointment even though the pharmacy doesn't offer it — renders its own composite column", () => {
    // Will, V-T-schedule-table: "do NOT hide it — render it as its own
    // column if it ever appears" (originally said of Pfizer 3-11 under
    // the 3-11/12+ split; still applies under the revised 12-64/65+
    // split — Pfizer only has fixed 12-64/65+ columns, so age bucket
    // "3-11" on a Pfizer appointment is exactly this case).
    const appointments: CountableAppointment[] = [
      {
        date: "2026-08-17",
        appointmentTypeId: 111,
        hourOfDay: 10,
        vaccineNames: ["COVID-Pfizer"],
        testNames: [],
        covidBrand: "pfizer" as const,
        covidAgeBucket: "3-11" as const,
        fluAgeBucket: "unknown" as const,
        createdDate: "2026-08-10",
      },
    ];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(result).toEqual([{ date: "2026-08-17", vaccineName: "COVID · Pfizer · 3-11", count: 1 }]);
  });

  // Flu age split (V-T-schedule-table ROUND 2, Will 2026-09-05): same
  // composite mechanism as COVID, riding the age bucket through the
  // VaccineCount cache/API shape as "Flu · {Age}".
  describe("Flu age composite", () => {
    it("splits Flu appointments into separate composite columns per age bucket", () => {
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          hourOfDay: 10,
          vaccineNames: ["Flu"],
          testNames: [],
          covidBrand: "any" as const,
          covidAgeBucket: "unknown" as const,
          fluAgeBucket: "3-64" as const,
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          hourOfDay: 10,
          vaccineNames: ["FluMist"],
          testNames: [],
          covidBrand: "any" as const,
          covidAgeBucket: "unknown" as const,
          fluAgeBucket: "65+" as const,
          createdDate: "2026-08-10",
        },
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          hourOfDay: 10,
          vaccineNames: ["Influenza Quadrivalent"],
          testNames: [],
          covidBrand: "any" as const,
          covidAgeBucket: "unknown" as const,
          fluAgeBucket: "unknown" as const,
          createdDate: "2026-08-10",
        },
      ];

      const result = aggregateAppointmentCounts(appointments, new Map());

      expect(result).toEqual([
        { date: "2026-08-17", vaccineName: "Flu · 3-64", count: 1 },
        { date: "2026-08-17", vaccineName: "Flu · 65+", count: 1 },
        { date: "2026-08-17", vaccineName: "Flu · Unknown", count: 1 },
      ]);
    });

    it("does not composite a non-Flu, non-COVID vaccine name even when its fluAgeBucket happens to be set", () => {
      // fluAgeBucket is derived per-appointment regardless of what
      // vaccine the appointment is actually for — isFluVaccineName gates
      // whether it's ever consulted, same as isCovidVaccineName for
      // covidBrand/covidAgeBucket.
      const appointments: CountableAppointment[] = [
        {
          date: "2026-08-17",
          appointmentTypeId: 111,
          hourOfDay: 10,
          vaccineNames: ["RSV"],
          testNames: [],
          covidBrand: "any" as const,
          covidAgeBucket: "unknown" as const,
          fluAgeBucket: "65+" as const,
          createdDate: "2026-08-10",
        },
      ];

      const result = aggregateAppointmentCounts(appointments, new Map());

      expect(result).toEqual([{ date: "2026-08-17", vaccineName: "RSV", count: 1 }]);
    });
  });
});

// V-T-hourly-table (Will, 2026-09-05): "Add a second table that shows
// hourly breakdown of how many vaccines are scheduled by the hour."
describe("aggregateHourlyCounts", () => {
  function appt(overrides: Partial<CountableAppointment> = {}): CountableAppointment {
    return {
      date: "2026-08-17",
      hourOfDay: 10,
      appointmentTypeId: 111,
      vaccineNames: [],
      testNames: [],
      covidBrand: "any",
      covidAgeBucket: "unknown",
      fluAgeBucket: "unknown",
      createdDate: "2026-08-10",
      ...overrides,
    };
  }

  it("counts a single-vaccine appointment as 1 appointment and 1 vaccine in its (date, hour) bucket", () => {
    const result = aggregateHourlyCounts([appt({ vaccineNames: ["Flu"] })]);

    expect(result).toEqual([{ date: "2026-08-17", hour: 10, appointmentCount: 1, vaccineCount: 1 }]);
  });

  it("counts a multi-vaccine visit as 1 appointment but N vaccines (Will: 'Flu and COVID-Pfizer' in one visit)", () => {
    const result = aggregateHourlyCounts([appt({ vaccineNames: ["Flu", "COVID-Pfizer"] })]);

    expect(result).toEqual([{ date: "2026-08-17", hour: 10, appointmentCount: 1, vaccineCount: 2 }]);
  });

  it("counts a fallback-to-type-name appointment (no vaccineNames) as exactly 1 vaccine, matching aggregateAppointmentCounts semantics", () => {
    const result = aggregateHourlyCounts([appt({ vaccineNames: [] })]);

    expect(result).toEqual([{ date: "2026-08-17", hour: 10, appointmentCount: 1, vaccineCount: 1 }]);
  });

  it("accumulates multiple appointments in the same (date, hour) bucket", () => {
    const result = aggregateHourlyCounts([
      appt({ vaccineNames: ["Flu"] }),
      appt({ vaccineNames: ["Flu", "COVID-Pfizer"] }),
      appt({ vaccineNames: [] }),
    ]);

    // 3 appointments; vaccine count = 1 + 2 + 1 = 4.
    expect(result).toEqual([{ date: "2026-08-17", hour: 10, appointmentCount: 3, vaccineCount: 4 }]);
  });

  it("buckets separately by hour within the same day, and separately by day at the same hour", () => {
    const result = aggregateHourlyCounts([
      appt({ date: "2026-08-17", hourOfDay: 9, vaccineNames: ["Flu"] }),
      appt({ date: "2026-08-17", hourOfDay: 14, vaccineNames: ["Flu"] }),
      appt({ date: "2026-08-18", hourOfDay: 9, vaccineNames: ["Flu"] }),
    ]);

    expect(result).toEqual([
      { date: "2026-08-17", hour: 9, appointmentCount: 1, vaccineCount: 1 },
      { date: "2026-08-17", hour: 14, appointmentCount: 1, vaccineCount: 1 },
      { date: "2026-08-18", hour: 9, appointmentCount: 1, vaccineCount: 1 },
    ]);
  });

  // Outside the dashboard's 8am-6pm display window — this aggregation
  // itself has no opinion on business hours (lib/appointment-table.ts's
  // buildHourlyBreakdownTable is what folds these into a day's "outside
  // 8-6" total), so an early-morning or evening appointment still gets a
  // real (date, hour) bucket rather than being dropped or clamped.
  it("includes appointments outside the 8am-6pm display window with their real hour", () => {
    const result = aggregateHourlyCounts([
      appt({ hourOfDay: 6, vaccineNames: ["Flu"] }), // 6am
      appt({ hourOfDay: 19, vaccineNames: ["Flu"] }), // 7pm
    ]);

    expect(result).toEqual([
      { date: "2026-08-17", hour: 6, appointmentCount: 1, vaccineCount: 1 },
      { date: "2026-08-17", hour: 19, appointmentCount: 1, vaccineCount: 1 },
    ]);
  });

  it("is sorted by date then hour", () => {
    const result = aggregateHourlyCounts([
      appt({ date: "2026-08-18", hourOfDay: 9 }),
      appt({ date: "2026-08-17", hourOfDay: 14 }),
      appt({ date: "2026-08-17", hourOfDay: 9 }),
    ]);

    expect(result.map((r) => [r.date, r.hour])).toEqual([
      ["2026-08-17", 9],
      ["2026-08-17", 14],
      ["2026-08-18", 9],
    ]);
  });

  it("returns [] for an empty input", () => {
    expect(aggregateHourlyCounts([])).toEqual([]);
  });

  // Defensive guard (see aggregateHourlyCounts's doc comment) — never
  // actually hit in practice, since fetchAppointmentsForRange only returns
  // entries whose hourOfDay is a real 0-23 value.
  it("skips an out-of-range hourOfDay (the -1 unparseable-datetime sentinel) rather than creating a bogus bucket", () => {
    const result = aggregateHourlyCounts([appt({ hourOfDay: -1, vaccineNames: ["Flu"] })]);

    expect(result).toEqual([]);
  });
});

// V-T-poc-testing (Will, 2026-09-08): point-of-care testing table backing
// aggregation — parallel in shape to aggregateAppointmentCounts, but see
// its own doc comment in lib/acuity-client.ts for the ONE deliberate
// difference: no "fall back to appointment type name" step, since every
// non-test appointment also has an empty testNames and must NOT show up
// here.
describe("aggregateTestCounts", () => {
  function testAppt(overrides: Partial<CountableAppointment> = {}): CountableAppointment {
    return {
      date: "2026-08-17",
      hourOfDay: 10,
      appointmentTypeId: 90788212,
      vaccineNames: [],
      testNames: [],
      covidBrand: "any",
      covidAgeBucket: "unknown",
      fluAgeBucket: "unknown",
      createdDate: "2026-08-10",
      ...overrides,
    };
  }

  it("groups by (date, testName) and counts", () => {
    const result = aggregateTestCounts([
      testAppt({ testNames: ["COVID"] }),
      testAppt({ testNames: ["COVID"] }),
      testAppt({ testNames: ["Strep Throat"] }),
      testAppt({ date: "2026-08-18", testNames: ["COVID"] }),
    ]);

    expect(result).toEqual([
      { date: "2026-08-17", testName: "COVID", count: 2 },
      { date: "2026-08-17", testName: "Strep Throat", count: 1 },
      { date: "2026-08-18", testName: "COVID", count: 1 },
    ]);
  });

  it("counts a multi-test appointment once toward EACH test name, same rule as aggregateAppointmentCounts", () => {
    const result = aggregateTestCounts([testAppt({ testNames: ["Flu", "COVID"] })]);

    expect(result).toEqual([
      { date: "2026-08-17", testName: "COVID", count: 1 },
      { date: "2026-08-17", testName: "Flu", count: 1 },
    ]);
  });

  it("excludes an appointment with an empty testNames — no fallback to appointment type name", () => {
    // A real vaccine appointment (empty testNames) must NEVER show up in
    // the point-of-care test table, even though its appointmentTypeId
    // could coincidentally collide with a test type's id in some other
    // account — this function doesn't even look at appointmentTypeId.
    const result = aggregateTestCounts([testAppt({ testNames: [] }), testAppt({ testNames: ["COVID"] })]);

    expect(result).toEqual([{ date: "2026-08-17", testName: "COVID", count: 1 }]);
  });

  it("returns [] for an empty input", () => {
    expect(aggregateTestCounts([])).toEqual([]);
  });
});
