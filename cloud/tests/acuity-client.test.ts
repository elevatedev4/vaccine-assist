import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateAppointmentCounts,
  fetchAppointmentsForRange,
  fetchAppointmentTypes,
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

// A fixture appointment shaped like a real Acuity API response — includes
// every PHI field Acuity actually returns (firstName/lastName/phone/email/
// notes/forms) precisely so the assertions below can prove none of it
// survives fetchAppointmentsForRange's projection.
function acuityAppointmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    firstName: "Jane",
    lastName: "Doe",
    phone: "555-123-4567",
    email: "jane.doe@example.com",
    date: "2026-08-17",
    time: "10:00am",
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

  it("strips every field down to {date, appointmentTypeId} — no PHI keys survive", async () => {
    const fixture = [
      acuityAppointmentFixture(),
      acuityAppointmentFixture({ id: 67890, firstName: "John", lastName: "Smith", date: "2026-08-18" }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result).toEqual([
      { date: "2026-08-17", appointmentTypeId: 111 },
      { date: "2026-08-18", appointmentTypeId: 111 },
    ]);

    const phiKeys = ["firstName", "lastName", "phone", "email", "notes", "forms", "id", "time"];
    for (const entry of result) {
      for (const key of phiKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }
    }
  });

  it("throws AcuityApiError on a non-ok response without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    await expect(fetchAppointmentsForRange("user-1", "super-secret", "2026-08-17", "2026-08-24")).rejects.toThrow(
      /rejected these credentials/i
    );
  });

  it("skips malformed entries (missing date or non-numeric type id)", async () => {
    const fixture = [
      acuityAppointmentFixture({ date: undefined }),
      acuityAppointmentFixture({ appointmentTypeID: "not-a-number" }),
      acuityAppointmentFixture({ date: "2026-08-19", appointmentTypeID: 222 }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 })));

    const result = await fetchAppointmentsForRange("user-1", "key-1", "2026-08-17", "2026-08-24");

    expect(result).toEqual([{ date: "2026-08-19", appointmentTypeId: 222 }]);
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
  it("groups by date + appointmentTypeId and counts, labeling with the type name", () => {
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111 },
      { date: "2026-08-17", appointmentTypeId: 111 },
      { date: "2026-08-17", appointmentTypeId: 222 },
      { date: "2026-08-18", appointmentTypeId: 111 },
    ];
    const names = new Map([
      [111, "Flu Shot"],
      [222, "COVID Booster"],
    ]);

    const result = aggregateAppointmentCounts(appointments, names);

    // Sorted by date, then appointmentTypeName (alphabetical) — "COVID
    // Booster" sorts before "Flu Shot" within the same day.
    expect(result).toEqual([
      { date: "2026-08-17", appointmentTypeId: 222, appointmentTypeName: "COVID Booster", count: 1 },
      { date: "2026-08-17", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 2 },
      { date: "2026-08-18", appointmentTypeId: 111, appointmentTypeName: "Flu Shot", count: 1 },
    ]);
  });

  it("falls back to a generic label when the type id has no matching name", () => {
    const result = aggregateAppointmentCounts([{ date: "2026-08-17", appointmentTypeId: 999 }], new Map());

    expect(result).toEqual([{ date: "2026-08-17", appointmentTypeId: 999, appointmentTypeName: "Type 999", count: 1 }]);
  });

  it("never emits PHI keys even if a caller (incorrectly) passed extra fields through", () => {
    // aggregateAppointmentCounts only ever destructures {date, appointmentTypeId}
    // off each input — extra fields on the input object must not leak into output.
    const appointments = [
      { date: "2026-08-17", appointmentTypeId: 111, firstName: "Jane", email: "jane@example.com" },
    ] as unknown as { date: string; appointmentTypeId: number }[];

    const result = aggregateAppointmentCounts(appointments, new Map());

    expect(Object.keys(result[0])).toEqual(["date", "appointmentTypeId", "appointmentTypeName", "count"]);
  });
});
