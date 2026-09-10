import { describe, expect, it } from "vitest";
import {
  activeFilterChips,
  addMonthsToDate,
  applyFilters,
  chunkDateRange,
  clearAllFilters,
  clearFilterKey,
  computeLeadDays,
  computeSums,
  dayOfWeekLabel,
  EMPTY_EXPLORER_FILTERS,
  formatHourLabel,
  groupedRowsToCsv,
  groupRows,
  isTestOnlyAppointment,
  matchesSearch,
  rowsToCsv,
  sortRows,
  vaccineCellValues,
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

// V-T-explorer round 4 (Will, verbatim): "On tests, vaccine related fields
// should be blank, not have unknown or any written in there." A
// point-of-care test appointment still carries acuity-client.ts's default
// covidBrand/covidAgeBucket/fluAgeBucket buckets ("any"/"unknown"/
// "unknown") even though the patient was never asked those questions —
// isTestOnlyAppointment/vaccineCellValues are the single place that turns
// those into blanks for display.
describe("isTestOnlyAppointment", () => {
  it("is true for a pure test appointment (testNames set, vaccineNames empty)", () => {
    expect(isTestOnlyAppointment({ vaccineNames: [], testNames: ["COVID"] })).toBe(true);
  });

  it("is false for a vaccine-only appointment", () => {
    expect(isTestOnlyAppointment({ vaccineNames: ["Flu"], testNames: [] })).toBe(false);
  });

  it("is false for a mixed vaccine+test appointment", () => {
    expect(isTestOnlyAppointment({ vaccineNames: ["Flu"], testNames: ["COVID"] })).toBe(false);
  });

  it("is false for an appointment with neither (e.g. an unrelated appointment type)", () => {
    expect(isTestOnlyAppointment({ vaccineNames: [], testNames: [] })).toBe(false);
  });
});

describe("vaccineCellValues", () => {
  it("blanks every vaccine-related cell for a test-only appointment", () => {
    const testRow = row({
      vaccineNames: [],
      testNames: ["COVID"],
      covidBrand: "any",
      covidAgeBucket: "unknown",
      fluAgeBucket: "unknown",
    });
    expect(vaccineCellValues(testRow)).toEqual({
      vaccineNamesDisplay: "",
      covidBrand: "",
      covidAgeBucket: "",
      fluAgeBucket: "",
    });
  });

  it("leaves a vaccine appointment's cells unchanged", () => {
    const vaccineRow = row({
      vaccineNames: ["Flu", "COVID-Pfizer"],
      testNames: [],
      covidBrand: "pfizer",
      covidAgeBucket: "12-64",
      fluAgeBucket: "3-64",
    });
    expect(vaccineCellValues(vaccineRow)).toEqual({
      vaccineNamesDisplay: "Flu, COVID-Pfizer",
      covidBrand: "pfizer",
      covidAgeBucket: "12-64",
      fluAgeBucket: "3-64",
    });
  });

  it("renders '—' for a non-test row that genuinely has no vaccineNames", () => {
    const emptyRow = row({ vaccineNames: [], testNames: [], covidBrand: "any", covidAgeBucket: "unknown", fluAgeBucket: "unknown" });
    expect(vaccineCellValues(emptyRow).vaccineNamesDisplay).toBe("—");
  });

  it("keeps a mixed vaccine+test appointment's vaccine cells filled (not blanked)", () => {
    const mixedRow = row({
      vaccineNames: ["Flu"],
      testNames: ["COVID"],
      covidBrand: "any",
      covidAgeBucket: "unknown",
      fluAgeBucket: "3-64",
    });
    expect(vaccineCellValues(mixedRow)).toEqual({
      vaccineNamesDisplay: "Flu",
      covidBrand: "any",
      covidAgeBucket: "unknown",
      fluAgeBucket: "3-64",
    });
  });
});

// V-T27 (Will, verbatim, 2026-09-09): "Group by should make groups and
// display the data in a table under each group. The current functionality
// is summing." — groupRows replaces the old count-only computeGroups: each
// group now carries its own full ExplorerRow list (rendered as a full rows
// table under the group's heading), with a "sensible order" per mode
// (dates ascending, names alphabetical) instead of the old
// descending-count sort.
describe("groupRows", () => {
  const rows = [
    row({ date: "2026-09-10", vaccineNames: ["Flu"], appointmentTypeName: "A", covidBrand: "any", covidAgeBucket: "unknown", fluAgeBucket: "3-64" }),
    row({ date: "2026-09-10", vaccineNames: ["Flu", "COVID-Pfizer"], appointmentTypeName: "A", covidBrand: "pfizer", covidAgeBucket: "12-64", fluAgeBucket: "3-64" }),
    row({ date: "2026-09-11", vaccineNames: ["COVID-Moderna"], appointmentTypeName: "B", covidBrand: "moderna", covidAgeBucket: "65+", fluAgeBucket: "unknown" }),
  ];

  it("returns [] for 'none'", () => {
    expect(groupRows(rows, "none")).toEqual([]);
  });

  it("groups by appointment date, each group carrying its own full row list, ordered chronologically", () => {
    const groups = groupRows(rows, "apptDate");
    expect(groups.map((g) => g.group)).toEqual(["2026-09-10", "2026-09-11"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].rows).toEqual([rows[0], rows[1]]);
    expect(groups[1].rows).toEqual([rows[2]]);
  });

  it("groups by booking date, 'Unknown' sorting after every real date", () => {
    const groups = groupRows(
      [
        row({ createdDate: "2026-09-02" }),
        row({ createdDate: "" }),
        row({ createdDate: "2026-09-01" }),
        row({ createdDate: "2026-09-01" }),
      ],
      "bookedOn"
    );
    expect(groups.map((g) => g.group)).toEqual(["2026-09-01", "2026-09-02", "Unknown"]);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("groups by day of week in calendar-week order (Sun..Sat), not alphabetical", () => {
    // 2026-09-10 is Thu, 2026-09-11 is Fri — alphabetically "Fri" < "Thu",
    // but calendar order puts Thu first.
    const groups = groupRows(rows, "day");
    expect(groups.map((g) => g.group)).toEqual(["Thu", "Fri"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("groups by hour, ordered by the underlying hour value (not the label's own alphabetical order)", () => {
    // "1 PM" would sort before "9 AM" alphabetically — the real order (9
    // AM before 1 PM) requires reading the underlying hourOfDay.
    const groups = groupRows([row({ hourOfDay: 13 }), row({ hourOfDay: 9 }), row({ hourOfDay: 9 })], "hour");
    expect(groups.map((g) => g.group)).toEqual(["9 AM", "1 PM"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("groups by appointment type, alphabetically", () => {
    const groups = groupRows(
      [row({ appointmentTypeName: "Z" }), row({ appointmentTypeName: "A" }), row({ appointmentTypeName: "A" })],
      "appointmentType"
    );
    expect(groups.map((g) => g.group)).toEqual(["A", "Z"]);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("groups by COVID brand", () => {
    const groups = groupRows(rows, "covidBrand");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows.length]));
    expect(byGroup["any"]).toBe(1);
    expect(byGroup["pfizer"]).toBe(1);
    expect(byGroup["moderna"]).toBe(1);
  });

  it("groups by COVID age bucket", () => {
    const groups = groupRows(rows, "covidAge");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows.length]));
    expect(byGroup["unknown"]).toBe(1);
    expect(byGroup["12-64"]).toBe(1);
    expect(byGroup["65+"]).toBe(1);
  });

  it("groups by Flu age bucket", () => {
    const groups = groupRows(rows, "fluAge");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows.length]));
    expect(byGroup["3-64"]).toBe(2);
    expect(byGroup["unknown"]).toBe(1);
  });

  it("groups by vaccine, a multi-vaccine appointment's row appearing under EACH of its vaccine groups (multi-membership)", () => {
    const groups = groupRows(rows, "vaccine");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows]));
    // "Flu" appears in rows[0] and rows[1] -> both under "Flu".
    expect(byGroup["Flu"]).toEqual([rows[0], rows[1]]);
    // rows[1] (Flu + COVID-Pfizer) ALSO appears under "COVID-Pfizer" — the
    // exact same row object, present in two different groups at once.
    expect(byGroup["COVID-Pfizer"]).toEqual([rows[1]]);
    expect(byGroup["COVID-Moderna"]).toEqual([rows[2]]);
    // Total row-memberships across groups (2 + 1 + 1 = 4) exceeds the 3
    // distinct appointments — the double-membership is intentional.
    const totalMemberships = groups.reduce((sum, g) => sum + g.rows.length, 0);
    expect(totalMemberships).toBe(4);
  });

  it("groups by test, double-membership across groups, a testless row EXCLUDED entirely (no '(none)' bucket)", () => {
    // V-T28 (Will, 2026-09-09: "If I'm grouping by 'vaccine' you shouldn't
    // show test appointments" — the mirror-image rule applies to "test"
    // mode too, per lib/appointment-explorer.ts's groupRows doc comment).
    const testRows = [
      row({ testNames: ["COVID"] }),
      row({ testNames: ["COVID", "Strep Throat"] }),
      row({ testNames: [] }),
    ];
    const groups = groupRows(testRows, "test");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows]));
    expect(byGroup["COVID"]).toEqual([testRows[0], testRows[1]]);
    expect(byGroup["Strep Throat"]).toEqual([testRows[1]]);
    expect(byGroup["(none)"]).toBeUndefined();
    expect(groups.reduce((sum, g) => sum + g.rows.length, 0)).toBe(3); // 2+1, testRows[2] excluded
  });

  it("groups by vaccine, double-membership across groups, a vaccine-less (test-only) row EXCLUDED entirely (no '(none)' bucket)", () => {
    // V-T28 (Will, verbatim): "If I'm grouping by 'vaccine' you shouldn't
    // show test appointments" — a point-of-care testing appointment has
    // vaccineNames: [] by construction, so it must not surface at all in
    // vaccine-mode group-by, not even under a placeholder bucket.
    const vaccineRows = [
      row({ vaccineNames: ["Flu"] }),
      row({ vaccineNames: ["Flu", "COVID-Pfizer"] }),
      row({ vaccineNames: [], testNames: ["COVID"] }),
    ];
    const groups = groupRows(vaccineRows, "vaccine");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.rows]));
    expect(byGroup["Flu"]).toEqual([vaccineRows[0], vaccineRows[1]]);
    expect(byGroup["COVID-Pfizer"]).toEqual([vaccineRows[1]]);
    expect(byGroup["(none)"]).toBeUndefined();
    expect(groups.some((g) => g.rows.includes(vaccineRows[2]))).toBe(false);
  });
});

describe("groupedRowsToCsv", () => {
  it("includes a leading 'Group' column before the normal headers", () => {
    const groups = groupRows([row({ date: "2026-09-10" })], "apptDate");
    const csv = groupedRowsToCsv(groups);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Group,Appt date,Day,Hour,Booked on,Lead days,Appointment type,Vaccines,Tests,# vaccines,COVID brand,COVID age,Flu age"
    );
  });

  it("writes one data row per (group, row) pair, group value first", () => {
    const groups = groupRows([row({ date: "2026-09-10" }), row({ date: "2026-09-11" })], "apptDate");
    const csv = groupedRowsToCsv(groups);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 groups of 1 row each
    expect(lines[1].startsWith("2026-09-10,2026-09-10,")).toBe(true);
    expect(lines[2].startsWith("2026-09-11,2026-09-11,")).toBe(true);
  });

  it("writes a multi-membership row once per group it belongs to, each line carrying that group's own label", () => {
    const multiVaccineRow = row({ vaccineNames: ["Flu", "COVID-Pfizer"] });
    const groups = groupRows([multiVaccineRow], "vaccine");
    const csv = groupedRowsToCsv(groups);
    const lines = csv.split("\n").slice(1); // drop header
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.startsWith("Flu,"))).toBe(true);
    expect(lines.some((line) => line.startsWith("COVID-Pfizer,"))).toBe(true);
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

  // Coordinator follow-up (verbatim): "route rowToCsvFields ... through
  // the same vaccineCellValues helper so test-only rows export empty
  // vaccine/COVID-brand/COVID-age/Flu-age fields instead of
  // 'any'/'unknown'" — same isTestOnlyAppointment/vaccineCellValues rule
  // the on-screen table uses (see the "vaccineCellValues" describe block
  // above), now applied to the CSV export path too.
  it("blanks COVID brand/COVID age/Flu age for a test-only row, same as the table", () => {
    const csv = rowsToCsv([
      row({
        vaccineNames: [],
        testNames: ["COVID"],
        appointmentTypeName: "Point of Care Testing",
        covidBrand: "any",
        covidAgeBucket: "unknown",
        fluAgeBucket: "unknown",
      }),
    ]);
    const dataLine = csv.split("\n")[1];
    // Vaccines "", Tests "COVID", # vaccines 0, COVID brand "", COVID age
    // "", Flu age "" — no "any"/"unknown" anywhere in the exported row.
    expect(dataLine).toBe("2026-09-10,Thu,10 AM,2026-09-01,9,Point of Care Testing,,COVID,0,,,");
  });

  it("keeps a mixed vaccine+test row's COVID brand/age fields filled in the CSV", () => {
    const csv = rowsToCsv([
      row({
        vaccineNames: ["Flu"],
        testNames: ["COVID"],
        covidBrand: "any",
        covidAgeBucket: "unknown",
        fluAgeBucket: "3-64",
      }),
    ]);
    const dataLine = csv.split("\n")[1];
    expect(dataLine).toBe("2026-09-10,Thu,10 AM,2026-09-01,9,Vaccine Appointment,Flu,COVID,1,any,unknown,3-64");
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

// V-T28 (Will, 2026-09-09 verbatim: "Make data explorer default to today
// as the starting point and go forward 3 months.") — backs the explorer
// page's defaultRangeDates.
describe("addMonthsToDate", () => {
  it("adds whole calendar months to a mid-month date", () => {
    expect(addMonthsToDate("2026-09-09", 3)).toBe("2026-12-09");
  });

  it("clamps to the target month's own last day rather than spilling into the month after (Jan 31 + 1 month)", () => {
    expect(addMonthsToDate("2026-01-31", 1)).toBe("2026-02-28"); // 2026 is not a leap year
  });

  it("clamps correctly across a leap-year February", () => {
    expect(addMonthsToDate("2028-01-31", 1)).toBe("2028-02-29"); // 2028 IS a leap year
  });

  it("rolls over into the following year", () => {
    expect(addMonthsToDate("2026-11-30", 3)).toBe("2027-02-28");
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
