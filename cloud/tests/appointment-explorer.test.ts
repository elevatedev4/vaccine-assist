import { describe, expect, it } from "vitest";
import {
  activeFilterChips,
  applyFilters,
  chunkDateRange,
  clearAllFilters,
  clearFilterKey,
  computeGroups,
  computeLeadDays,
  computeSums,
  dayOfWeekLabel,
  EMPTY_EXPLORER_FILTERS,
  formatHourLabel,
  matchesSearch,
  rowsToCsv,
  sortRows,
  type ExplorerFilters,
  type ExplorerRow,
} from "@/lib/appointment-explorer";

function row(overrides: Partial<ExplorerRow> = {}): ExplorerRow {
  return {
    date: "2026-09-10",
    createdDate: "2026-09-01",
    appointmentTypeId: 111,
    appointmentTypeName: "Vaccine Appointment",
    vaccineNames: ["Flu"],
    testNames: [],
    covidBrand: "any",
    covidAgeBucket: "unknown",
    fluAgeBucket: "3-64",
    hourOfDay: 10,
    ...overrides,
  };
}

describe("dayOfWeekLabel", () => {
  it("returns the abbreviated weekday for a YYYY-MM-DD date", () => {
    // 2026-09-10 is a Thursday.
    expect(dayOfWeekLabel("2026-09-10")).toBe("Thu");
  });

  it("returns '' for an unparseable date", () => {
    expect(dayOfWeekLabel("not-a-date")).toBe("");
  });
});

describe("formatHourLabel", () => {
  it("formats morning hours", () => {
    expect(formatHourLabel(10)).toBe("10 AM");
  });

  it("formats noon and midnight correctly", () => {
    expect(formatHourLabel(0)).toBe("12 AM");
    expect(formatHourLabel(12)).toBe("12 PM");
  });

  it("formats afternoon hours", () => {
    expect(formatHourLabel(17)).toBe("5 PM");
  });

  it("returns an em dash for an out-of-range hour", () => {
    expect(formatHourLabel(-1)).toBe("—");
    expect(formatHourLabel(24)).toBe("—");
  });
});

describe("computeLeadDays", () => {
  it("computes whole days between createdDate and date", () => {
    expect(computeLeadDays(row({ date: "2026-09-10", createdDate: "2026-09-01" }))).toBe(9);
  });

  it("returns a negative number for a same-day-or-later booking anomaly", () => {
    expect(computeLeadDays(row({ date: "2026-09-01", createdDate: "2026-09-05" }))).toBe(-4);
  });

  it("returns null when createdDate is missing", () => {
    expect(computeLeadDays(row({ createdDate: "" }))).toBeNull();
  });

  it("returns null when date is unparseable", () => {
    expect(computeLeadDays(row({ date: "bad-date" }))).toBeNull();
  });
});

describe("matchesSearch", () => {
  it("matches on vaccine name, case-insensitively", () => {
    expect(matchesSearch(row({ vaccineNames: ["COVID-Pfizer"] }), "pfizer")).toBe(true);
  });

  it("matches on appointment type name", () => {
    expect(matchesSearch(row({ appointmentTypeName: "Flu Shot Clinic" }), "clinic")).toBe(true);
  });

  it("matches on covid brand/age buckets", () => {
    expect(matchesSearch(row({ covidBrand: "moderna" }), "moderna")).toBe(true);
    expect(matchesSearch(row({ covidAgeBucket: "12-64" }), "12-64")).toBe(true);
  });

  it("matches on date strings", () => {
    expect(matchesSearch(row({ date: "2026-09-10" }), "2026-09-10")).toBe(true);
  });

  it("returns true for blank/whitespace queries (no filter)", () => {
    expect(matchesSearch(row(), "")).toBe(true);
    expect(matchesSearch(row(), "   ")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesSearch(row({ vaccineNames: ["Flu"] }), "shingles")).toBe(false);
  });

  it("matches on test names", () => {
    expect(matchesSearch(row({ testNames: ["COVID"] }), "covid")).toBe(true);
  });
});

describe("applyFilters", () => {
  const rows = [
    row({ date: "2026-09-10", hourOfDay: 10, appointmentTypeName: "A", vaccineNames: ["Flu"], covidBrand: "any" }),
    row({ date: "2026-09-11", hourOfDay: 14, appointmentTypeName: "B", vaccineNames: ["COVID-Pfizer"], covidBrand: "pfizer" }),
    row({ date: "2026-09-12", hourOfDay: 10, appointmentTypeName: "A", vaccineNames: ["Flu", "COVID-Moderna"], covidBrand: "moderna" }),
  ];

  it("applies the free-text search", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, search: "pfizer" });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-09-11");
  });

  it("filters by apptDateText substring", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, apptDateText: "2026-09-11" });
    expect(result).toHaveLength(1);
  });

  it("filters by bookedOnText substring", () => {
    const withCreated = [row({ createdDate: "2026-08-01" }), row({ createdDate: "2026-08-15" })];
    const result = applyFilters(withCreated, { ...EMPTY_EXPLORER_FILTERS, bookedOnText: "08-15" });
    expect(result).toHaveLength(1);
  });

  it("filters by leadDaysText substring against the computed value", () => {
    // date 2026-09-01, createdDate 2026-09-05 -> lead days -4
    const negative = row({ date: "2026-09-01", createdDate: "2026-09-05" });
    const positive = row({ date: "2026-09-10", createdDate: "2026-09-01" });
    const result = applyFilters([negative, positive], { ...EMPTY_EXPLORER_FILTERS, leadDaysText: "-" });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(negative);
  });

  it("filters by vaccineCountText substring", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, vaccineCountText: "2" });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-09-12");
  });

  it("filters by day multi-select", () => {
    // 2026-09-10 Thu, 2026-09-11 Fri, 2026-09-12 Sat
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, day: ["Fri", "Sat"] });
    expect(result).toHaveLength(2);
  });

  it("filters by hour multi-select", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, hour: ["10 AM"] });
    expect(result).toHaveLength(2);
  });

  it("filters by appointmentType multi-select", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, appointmentType: ["B"] });
    expect(result).toHaveLength(1);
  });

  it("filters by vaccine multi-select (matches if ANY vaccineName is selected)", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, vaccine: ["COVID-Moderna"] });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-09-12");
  });

  it("filters by tests multi-select (matches if ANY testName is selected)", () => {
    const testRows = [
      row({ date: "2026-09-10", testNames: [] }),
      row({ date: "2026-09-11", testNames: ["COVID"] }),
      row({ date: "2026-09-12", testNames: ["COVID", "Strep Throat"] }),
    ];
    const result = applyFilters(testRows, { ...EMPTY_EXPLORER_FILTERS, tests: ["Strep Throat"] });
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-09-12");
  });

  it("filters by covidBrand multi-select", () => {
    const result = applyFilters(rows, { ...EMPTY_EXPLORER_FILTERS, covidBrand: ["pfizer", "moderna"] });
    expect(result).toHaveLength(2);
  });

  it("filters by covidAge multi-select", () => {
    const ages = [row({ covidAgeBucket: "3-11" }), row({ covidAgeBucket: "65+" })];
    const result = applyFilters(ages, { ...EMPTY_EXPLORER_FILTERS, covidAge: ["65+"] });
    expect(result).toHaveLength(1);
  });

  it("filters by fluAge multi-select", () => {
    const ages = [row({ fluAgeBucket: "3-64" }), row({ fluAgeBucket: "65+" })];
    const result = applyFilters(ages, { ...EMPTY_EXPLORER_FILTERS, fluAge: ["65+"] });
    expect(result).toHaveLength(1);
  });

  it("combines multiple filters with AND semantics", () => {
    const result = applyFilters(rows, {
      ...EMPTY_EXPLORER_FILTERS,
      appointmentType: ["A"],
      hour: ["10 AM"],
    });
    expect(result).toHaveLength(2);
    const result2 = applyFilters(rows, {
      ...EMPTY_EXPLORER_FILTERS,
      appointmentType: ["A"],
      vaccine: ["COVID-Moderna"],
    });
    expect(result2).toHaveLength(1);
  });
});

describe("sortRows", () => {
  const rows = [
    row({ date: "2026-09-12", hourOfDay: 8, vaccineNames: ["Flu"] }),
    row({ date: "2026-09-10", hourOfDay: 14, vaccineNames: ["Flu", "COVID-Pfizer"] }),
    row({ date: "2026-09-11", hourOfDay: 10, vaccineNames: [] }),
  ];

  it("sorts by date ascending", () => {
    const sorted = sortRows(rows, "date", "asc");
    expect(sorted.map((r) => r.date)).toEqual(["2026-09-10", "2026-09-11", "2026-09-12"]);
  });

  it("sorts by date descending", () => {
    const sorted = sortRows(rows, "date", "desc");
    expect(sorted.map((r) => r.date)).toEqual(["2026-09-12", "2026-09-11", "2026-09-10"]);
  });

  it("sorts by hour numerically, not lexicographically", () => {
    const sorted = sortRows(rows, "hour", "asc");
    expect(sorted.map((r) => r.hourOfDay)).toEqual([8, 10, 14]);
  });

  it("sorts by vaccineCount numerically", () => {
    const sorted = sortRows(rows, "vaccineCount", "asc");
    expect(sorted.map((r) => r.vaccineNames.length)).toEqual([0, 1, 2]);
  });

  it("does not mutate the input array", () => {
    const copy = [...rows];
    sortRows(rows, "date", "asc");
    expect(rows).toEqual(copy);
  });
});

describe("computeSums", () => {
  it("computes appointment count, vaccine count, and average vaccines/appt", () => {
    const rows = [row({ vaccineNames: ["Flu"] }), row({ vaccineNames: ["Flu", "COVID-Pfizer"] }), row({ vaccineNames: [] })];
    const sums = computeSums(rows);
    expect(sums.appointments).toBe(3);
    expect(sums.vaccines).toBe(3);
    expect(sums.avgVaccinesPerAppointment).toBeCloseTo(1);
  });

  it("computes average lead days, excluding rows with no computable lead time", () => {
    const rows = [
      row({ date: "2026-09-10", createdDate: "2026-09-01" }), // 9
      row({ date: "2026-09-10", createdDate: "2026-09-05" }), // 5
      row({ date: "2026-09-10", createdDate: "" }), // excluded
    ];
    const sums = computeSums(rows);
    expect(sums.avgLeadDays).toBeCloseTo(7);
  });

  it("returns 0/null-safe values for an empty set", () => {
    const sums = computeSums([]);
    expect(sums).toEqual({ appointments: 0, vaccines: 0, avgVaccinesPerAppointment: 0, avgLeadDays: null });
  });
});

describe("computeGroups", () => {
  const rows = [
    row({ date: "2026-09-10", vaccineNames: ["Flu"], appointmentTypeName: "A", covidBrand: "any", covidAgeBucket: "unknown", fluAgeBucket: "3-64" }),
    row({ date: "2026-09-10", vaccineNames: ["Flu", "COVID-Pfizer"], appointmentTypeName: "A", covidBrand: "pfizer", covidAgeBucket: "12-64", fluAgeBucket: "3-64" }),
    row({ date: "2026-09-11", vaccineNames: ["COVID-Moderna"], appointmentTypeName: "B", covidBrand: "moderna", covidAgeBucket: "65+", fluAgeBucket: "unknown" }),
  ];

  it("returns [] for 'none'", () => {
    expect(computeGroups(rows, "none")).toEqual([]);
  });

  it("groups by appointment date", () => {
    const groups = computeGroups(rows, "apptDate");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["2026-09-10"].appointments).toBe(2);
    expect(byGroup["2026-09-10"].vaccines).toBe(3); // 1 + 2
    expect(byGroup["2026-09-11"].appointments).toBe(1);
    expect(byGroup["2026-09-11"].pctOfAppointments).toBeCloseTo((1 / 3) * 100);
  });

  it("groups by booking date", () => {
    const groups = computeGroups(
      [row({ createdDate: "2026-09-01" }), row({ createdDate: "2026-09-01" }), row({ createdDate: "2026-09-02" })],
      "bookedOn"
    );
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["2026-09-01"].appointments).toBe(2);
    expect(byGroup["2026-09-02"].appointments).toBe(1);
  });

  it("groups by day of week", () => {
    // 2026-09-10 Thu, 2026-09-11 Fri
    const groups = computeGroups(rows, "day");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["Thu"].appointments).toBe(2);
    expect(byGroup["Fri"].appointments).toBe(1);
  });

  it("groups by hour", () => {
    const groups = computeGroups([row({ hourOfDay: 9 }), row({ hourOfDay: 9 }), row({ hourOfDay: 13 })], "hour");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["9 AM"].appointments).toBe(2);
    expect(byGroup["1 PM"].appointments).toBe(1);
  });

  it("groups by appointment type", () => {
    const groups = computeGroups(rows, "appointmentType");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["A"].appointments).toBe(2);
    expect(byGroup["B"].appointments).toBe(1);
  });

  it("groups by COVID brand", () => {
    const groups = computeGroups(rows, "covidBrand");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["any"].appointments).toBe(1);
    expect(byGroup["pfizer"].appointments).toBe(1);
    expect(byGroup["moderna"].appointments).toBe(1);
  });

  it("groups by COVID age bucket", () => {
    const groups = computeGroups(rows, "covidAge");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["unknown"].appointments).toBe(1);
    expect(byGroup["12-64"].appointments).toBe(1);
    expect(byGroup["65+"].appointments).toBe(1);
  });

  it("groups by Flu age bucket", () => {
    const groups = computeGroups(rows, "fluAge");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    expect(byGroup["3-64"].appointments).toBe(2);
    expect(byGroup["unknown"].appointments).toBe(1);
  });

  it("groups by vaccine, double-counting a multi-vaccine appointment across both groups", () => {
    const groups = computeGroups(rows, "vaccine");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    // "Flu" appears in rows 1 and 2 -> 2 occurrences.
    expect(byGroup["Flu"].appointments).toBe(2);
    expect(byGroup["Flu"].vaccines).toBe(2);
    // "COVID-Pfizer" appears once (row 2, which also counted toward Flu).
    expect(byGroup["COVID-Pfizer"].appointments).toBe(1);
    // "COVID-Moderna" appears once (row 3).
    expect(byGroup["COVID-Moderna"].appointments).toBe(1);
    // Total occurrences across groups (2 + 1 + 1 = 4) exceeds the 3 total
    // appointments — the double-count is intentional, per the spec.
    const totalOccurrences = groups.reduce((sum, g) => sum + g.appointments, 0);
    expect(totalOccurrences).toBe(4);
  });

  it("groups by test, double-counting a multi-test appointment across both groups", () => {
    const testRows = [
      row({ testNames: ["COVID"] }),
      row({ testNames: ["COVID", "Strep Throat"] }),
      row({ testNames: [] }),
    ];
    const groups = computeGroups(testRows, "test");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g]));
    // "COVID" appears in rows 1 and 2 -> 2 occurrences.
    expect(byGroup["COVID"].appointments).toBe(2);
    // "Strep Throat" appears once (row 2).
    expect(byGroup["Strep Throat"].appointments).toBe(1);
    // A row with no test names buckets under "(none)".
    expect(byGroup["(none)"].appointments).toBe(1);
  });

  it("sorts groups by descending appointment count, ties broken alphabetically", () => {
    const groups = computeGroups(
      [row({ appointmentTypeName: "Z" }), row({ appointmentTypeName: "A" }), row({ appointmentTypeName: "A" })],
      "appointmentType"
    );
    expect(groups.map((g) => g.group)).toEqual(["A", "Z"]);
  });
});

describe("rowsToCsv", () => {
  it("includes the header row and one data row per appointment", () => {
    const csv = rowsToCsv([row()]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Appt date,Day,Hour,Booked on,Lead days,Appointment type,Vaccines,Tests,# vaccines,COVID brand,COVID age,Flu age"
    );
    expect(lines).toHaveLength(2);
  });

  it("escapes fields containing commas", () => {
    const csv = rowsToCsv([row({ appointmentTypeName: "Flu, Walk-in" })]);
    expect(csv).toContain('"Flu, Walk-in"');
  });

  it("escapes fields containing quotes by doubling them", () => {
    const csv = rowsToCsv([row({ appointmentTypeName: 'The "Big" Clinic' })]);
    expect(csv).toContain('"The ""Big"" Clinic"');
  });

  it("joins multiple vaccine names with a comma and quotes the field", () => {
    const csv = rowsToCsv([row({ vaccineNames: ["Flu", "COVID-Pfizer"] })]);
    expect(csv).toContain('"Flu, COVID-Pfizer"');
  });

  it("includes the Tests column, joining multiple test names with a comma", () => {
    const csv = rowsToCsv([row({ testNames: ["COVID", "Strep Throat"] })]);
    expect(csv).toContain('"COVID, Strep Throat"');
  });

  it("leaves plain fields unquoted", () => {
    const csv = rowsToCsv([row()]);
    const dataLine = csv.split("\n")[1];
    expect(
      dataLine.startsWith("2026-09-10,Thu,10 AM,2026-09-01,9,Vaccine Appointment,Flu,,1,any,unknown,3-64")
    ).toBe(true);
  });
});

describe("chunkDateRange", () => {
  it("returns a single chunk when the range fits within maxDays", () => {
    const chunks = chunkDateRange("2026-09-01", "2026-09-10", 31);
    expect(chunks).toEqual([{ start: "2026-09-01", end: "2026-09-10" }]);
  });

  it("splits a 70-day range into 31/31/8-day chunks", () => {
    // 2026-01-01 .. 2026-03-11 inclusive = 70 days.
    const chunks = chunkDateRange("2026-01-01", "2026-03-11", 31);
    expect(chunks).toEqual([
      { start: "2026-01-01", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-03-03" },
      { start: "2026-03-04", end: "2026-03-11" },
    ]);

    function spanDays(start: string, end: string): number {
      const [y1, m1, d1] = start.split("-").map(Number);
      const [y2, m2, d2] = end.split("-").map(Number);
      const a = Date.UTC(y1, m1 - 1, d1);
      const b = Date.UTC(y2, m2 - 1, d2);
      return Math.round((b - a) / 86_400_000) + 1;
    }

    expect(spanDays(chunks[0].start, chunks[0].end)).toBe(31);
    expect(spanDays(chunks[1].start, chunks[1].end)).toBe(31);
    expect(spanDays(chunks[2].start, chunks[2].end)).toBe(8);
  });

  it("chunks cover the whole range contiguously with no gaps or overlaps", () => {
    const chunks = chunkDateRange("2026-01-01", "2026-03-11", 31);
    expect(chunks[0].start).toBe("2026-01-01");
    expect(chunks[chunks.length - 1].end).toBe("2026-03-11");
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = new Date(`${chunks[i - 1].end}T12:00:00Z`);
      const thisStart = new Date(`${chunks[i].start}T12:00:00Z`);
      expect(thisStart.getTime() - prevEnd.getTime()).toBe(86_400_000);
    }
  });

  it("returns a single exact-fit chunk when the range is exactly maxDays", () => {
    const chunks = chunkDateRange("2026-08-01", "2026-08-31", 31);
    expect(chunks).toEqual([{ start: "2026-08-01", end: "2026-08-31" }]);
  });
});

// V-T24 (Will, verbatim): "The filtering option needs to be more refined,
// it's very clunky right now and I don't see a way to clear the filters."
describe("activeFilterChips", () => {
  it("returns [] when no filter is active", () => {
    expect(activeFilterChips(EMPTY_EXPLORER_FILTERS)).toEqual([]);
  });

  it("returns [] when every text field is only whitespace", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, apptDateText: "   ", search: "  " };
    expect(activeFilterChips(filters)).toEqual([]);
  });

  it("builds one chip per active text field, label trimmed", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, leadDaysText: " 3 " };
    expect(activeFilterChips(filters)).toEqual([{ key: "leadDaysText", label: "Lead days: 3" }]);
  });

  it("builds one chip per active checklist field, joining selected values with ', '", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, day: ["Mon", "Tue"] };
    expect(activeFilterChips(filters)).toEqual([{ key: "day", label: "Day: Mon, Tue" }]);
  });

  it("orders chips: text columns, then checklist columns, then search LAST", () => {
    const filters: ExplorerFilters = {
      ...EMPTY_EXPLORER_FILTERS,
      search: "flu",
      leadDaysText: "3",
      day: ["Mon", "Tue"],
    };

    expect(activeFilterChips(filters)).toEqual([
      { key: "leadDaysText", label: "Lead days: 3" },
      { key: "day", label: "Day: Mon, Tue" },
      { key: "search", label: "Search: flu" },
    ]);
  });

  it("builds a chip for every distinct active filter across all columns at once", () => {
    const filters: ExplorerFilters = {
      ...EMPTY_EXPLORER_FILTERS,
      apptDateText: "2026-09",
      bookedOnText: "2026-08",
      leadDaysText: "-",
      vaccineCountText: "2",
      day: ["Mon"],
      hour: ["10 AM"],
      appointmentType: ["Vaccine Appointment"],
      vaccine: ["Flu"],
      tests: ["COVID"],
      covidBrand: ["pfizer"],
      covidAge: ["12-64"],
      fluAge: ["3-64"],
      search: "flu",
    };

    expect(activeFilterChips(filters).map((chip) => chip.key)).toEqual([
      "apptDateText",
      "bookedOnText",
      "leadDaysText",
      "vaccineCountText",
      "day",
      "hour",
      "appointmentType",
      "vaccine",
      "tests",
      "covidBrand",
      "covidAge",
      "fluAge",
      "search",
    ]);
  });

  it("builds a chip for the tests filter, like vaccine", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, tests: ["COVID", "Strep Throat"] };
    expect(activeFilterChips(filters)).toEqual([{ key: "tests", label: "Tests: COVID, Strep Throat" }]);
  });
});

describe("clearFilterKey", () => {
  it("resets a text field back to '' without touching any other field", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, leadDaysText: "3", search: "flu" };

    const result = clearFilterKey(filters, "leadDaysText");

    expect(result.leadDaysText).toBe("");
    expect(result.search).toBe("flu");
  });

  it("resets a checklist field back to [] without touching any other field", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, day: ["Mon", "Tue"], hour: ["10 AM"] };

    const result = clearFilterKey(filters, "day");

    expect(result.day).toEqual([]);
    expect(result.hour).toEqual(["10 AM"]);
  });

  it("clearing 'search' via its own chip key only clears search", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, search: "flu", day: ["Mon"] };

    const result = clearFilterKey(filters, "search");

    expect(result.search).toBe("");
    expect(result.day).toEqual(["Mon"]);
  });

  it("returns a fresh array for a cleared checklist field — never the shared EMPTY_EXPLORER_FILTERS instance", () => {
    const filters: ExplorerFilters = { ...EMPTY_EXPLORER_FILTERS, day: ["Mon"] };

    const result = clearFilterKey(filters, "day");
    result.day.push("Tue");

    expect(EMPTY_EXPLORER_FILTERS.day).toEqual([]);
  });
});

describe("clearAllFilters", () => {
  it("returns a filters object equal to EMPTY_EXPLORER_FILTERS", () => {
    expect(clearAllFilters()).toEqual(EMPTY_EXPLORER_FILTERS);
  });

  it("returns a fresh object each call — mutating the result never leaks into a later call", () => {
    const first = clearAllFilters();
    first.day.push("Mon");

    const second = clearAllFilters();

    expect(second.day).toEqual([]);
  });
});
