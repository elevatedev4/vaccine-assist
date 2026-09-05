import { describe, expect, it } from "vitest";
import {
  buildAppointmentTable,
  compositeNameToMatchableBase,
  type AppointmentTableColumn,
} from "@/lib/appointment-table";

const DAYS = ["2026-08-17", "2026-08-18", "2026-08-19"];

// The 18 fixed columns, in Will's exact mockup order (V-T-schedule-table
// ROUND 2), always present regardless of input — see FIXED_COLUMNS in
// lib/appointment-table.ts. Used below to assert both the always-zero
// case and that the ordering never drifts.
const FIXED_COLUMN_IDS = [
  "pfizer_12-64",
  "pfizer_65+",
  "moderna_3-11",
  "moderna_12-64",
  "moderna_65+",
  "any_3-11",
  "any_12-64",
  "any_65+",
  "flu_3-64",
  "flu_65+",
  "flu_unknown",
  "meningitis",
  "typhoid",
  "mmr",
  "shingles",
  "pneumonia",
  "tetanus",
  "rsv",
  "hpv",
  "hepA",
  "hepB",
];

function zeroedDays(): Record<string, number> {
  return Object.fromEntries(DAYS.map((d) => [d, 0]));
}

describe("buildAppointmentTable", () => {
  describe("fixed columns (V-T-schedule-table ROUND 2)", () => {
    it("renders all 18 fixed columns, in Will's exact order, even when counts is empty", () => {
      const table = buildAppointmentTable([], DAYS);

      expect(table.columns.map((c) => c.vaccineName)).toEqual(FIXED_COLUMN_IDS);
      expect(table.rows.map((r) => r.vaccineName)).toEqual(FIXED_COLUMN_IDS);
      // Every fixed row is zeroed, not omitted — this IS "renders even
      // with zero data, including when the poll returns nothing."
      for (const row of table.rows) {
        expect(row.countsByDay).toEqual(zeroedDays());
        expect(row.total).toBe(0);
      }
      expect(table.dailyTotals).toEqual(zeroedDays());
      expect(table.grandTotal).toBe(0);
    });

    it("gives the fixed columns their short chart labels and correct group/subgroup nesting", () => {
      const table = buildAppointmentTable([], DAYS);
      const byId = new Map(table.columns.map((c) => [c.vaccineName, c]));

      expect(byId.get("pfizer_12-64")).toEqual({
        vaccineName: "pfizer_12-64",
        group: "COVID",
        subgroup: "Pfizer",
        label: "12-64",
      });
      expect(byId.get("moderna_3-11")).toEqual({
        vaccineName: "moderna_3-11",
        group: "COVID",
        subgroup: "Mod",
        label: "3-11",
      });
      expect(byId.get("any_65+")).toEqual({
        vaccineName: "any_65+",
        group: "COVID",
        subgroup: "Any",
        label: "65+",
      });
      expect(byId.get("flu_3-64")).toEqual({ vaccineName: "flu_3-64", group: "Flu", subgroup: null, label: "3-64" });
      expect(byId.get("flu_unknown")).toEqual({
        vaccineName: "flu_unknown",
        group: "Flu",
        subgroup: null,
        label: "Unk",
      });
      // Short chart labels, not form wording (Will: "Don't write Tetanus/
      // whooping cough, just write Tdap").
      expect(byId.get("tetanus")).toEqual({ vaccineName: "tetanus", group: null, subgroup: null, label: "Tdap" });
      expect(byId.get("hepA")).toEqual({ vaccineName: "hepA", group: null, subgroup: null, label: "Hep A" });
    });

    it("Total is not one of the fixed columns — page.tsx renders it separately as the 2nd column", () => {
      const table = buildAppointmentTable([], DAYS);
      expect(table.columns.some((c) => c.label === "Total")).toBe(false);
      // grandTotal / dailyTotals / row.total carry the "Total" data —
      // see app/appointments/page.tsx for where that renders.
      expect(table).toHaveProperty("grandTotal");
      expect(table).toHaveProperty("dailyTotals");
    });
  });

  describe("canonical vaccine-name mapping onto fixed columns", () => {
    it.each([
      ["Meningitis", "meningitis"],
      ["Menactra", "meningitis"],
      ["MenQuadfi", "meningitis"],
      ["Menveo", "meningitis"],
      ["Typhoid Vaccine", "typhoid"],
      ["Typhim Vi", "typhoid"],
      ["MMR-II", "mmr"],
      ["mmr", "mmr"],
      ["Shingles", "shingles"],
      ["Shingrix", "shingles"],
      ["Zoster Vaccine", "shingles"],
      ["Pneumonia Vaccine", "pneumonia"],
      ["Prevnar 20", "pneumonia"],
      ["Pneumovax 23", "pneumonia"],
      ["PCV15", "pneumonia"],
      ["Tetanus Booster", "tetanus"],
      ["Tdap", "tetanus"],
      ["RSV Vaccine", "rsv"],
      ["Abrysvo", "rsv"],
      ["Arexvy", "rsv"],
      ["HPV Vaccine", "hpv"],
      ["Gardasil 9", "hpv"],
      ["Hep A", "hepA"],
      ["Havrix", "hepA"],
      ["Vaqta", "hepA"],
      ["Hepatitis A", "hepA"],
      ["Hep B", "hepB"],
      ["Heplisav-B", "hepB"],
      ["Engerix-B", "hepB"],
      ["Hepatitis B", "hepB"],
    ])("maps %s onto the fixed %s column", (rawName, expectedId) => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: rawName, count: 1 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === expectedId)!;

      expect(row).toBeDefined();
      expect(row.countsByDay["2026-08-17"]).toBe(1);
      expect(row.total).toBe(1);
      // No extra column was created for it.
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    // "td" is a dangerously short token to substring-match (Will's brief:
    // "careful: 'td' is a dangerously short token — require word-boundary
    // match"). A bare "Td" answer must match; "td" appearing inside an
    // unrelated word must not.
    describe("tetanus 'td' word-boundary trap", () => {
      it("matches a bare 'Td' answer as tetanus", () => {
        const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "Td", count: 1 }], DAYS);
        const row = table.rows.find((r) => r.vaccineName === "tetanus")!;
        expect(row.countsByDay["2026-08-17"]).toBe(1);
      });

      it("matches 'Td booster' (word-boundary both sides) as tetanus", () => {
        const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "Td booster", count: 1 }], DAYS);
        const row = table.rows.find((r) => r.vaccineName === "tetanus")!;
        expect(row.countsByDay["2026-08-17"]).toBe(1);
      });

      it("does NOT let 'td' appearing mid-word false-positive into tetanus", () => {
        // "outdoor" contains the substring "td" but not as its own word —
        // \btd\b must not match it. This name doesn't match any other
        // canonical column either, so it becomes its own extra column.
        const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "Outdoor Clinic Visit", count: 1 }], DAYS);
        const tetanusRow = table.rows.find((r) => r.vaccineName === "tetanus")!;
        expect(tetanusRow.countsByDay["2026-08-17"]).toBe(0);

        const extra = table.rows.find((r) => r.vaccineName === "Outdoor Clinic Visit");
        expect(extra).toBeDefined();
        expect(extra!.countsByDay["2026-08-17"]).toBe(1);
      });
    });

    it("routes a stale pre-composite raw Flu name (old cache row, no age info) to the fixed Flu Unk column", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "Flu Shot", count: 3 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === "flu_unknown")!;
      expect(row.countsByDay["2026-08-17"]).toBe(3);
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    it("parses the COVID composite name (from acuity-client's covidCompositeName) onto the matching fixed column", () => {
      const table = buildAppointmentTable(
        [{ date: "2026-08-17", vaccineName: "COVID · Moderna · 65+", count: 2 }],
        DAYS
      );
      const row = table.rows.find((r) => r.vaccineName === "moderna_65+")!;
      expect(row.countsByDay["2026-08-17"]).toBe(2);
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    it("parses the Flu composite name (from acuity-client's fluCompositeName) onto the matching fixed column", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "Flu · 3-64", count: 4 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === "flu_3-64")!;
      expect(row.countsByDay["2026-08-17"]).toBe(4);
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    it("appends an unrecognized vaccine name as its own extra column after the fixed set, never hiding it", () => {
      const table = buildAppointmentTable(
        [{ date: "2026-08-17", vaccineName: "Brand New Vaccine 2027", count: 5 }],
        DAYS
      );

      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
      const extraColumn = table.columns[table.columns.length - 1];
      expect(extraColumn).toEqual({
        vaccineName: "Brand New Vaccine 2027",
        group: null,
        subgroup: null,
        label: "Brand New Vaccine 2027",
      });
      const extraRow = table.rows[table.rows.length - 1];
      expect(extraRow.countsByDay["2026-08-17"]).toBe(5);
      expect(extraRow.total).toBe(5);
    });

    // Per-brand Unknown-age columns and any other unusual COVID brand/age
    // combo Will's mockup doesn't list (e.g. Pfizer 3-11, which isn't one
    // of Pfizer's two fixed columns) are NOT part of the fixed set — they
    // become extra columns that only appear when they actually have a
    // count, which IS the "render only when nonzero" behavior (requirement
    // 1b) — one mechanism serves both.
    describe("unusual COVID combos render only when nonzero (extra-column mechanism)", () => {
      it("a brand's Unknown-age composite becomes its own extra column, not a fixed one", () => {
        const table = buildAppointmentTable(
          [{ date: "2026-08-17", vaccineName: "COVID · Pfizer · Unknown", count: 1 }],
          DAYS
        );

        expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
        const extra = table.columns[table.columns.length - 1];
        expect(extra.group).toBe("COVID");
        expect(extra.subgroup).toBe("Pfizer");
        expect(extra.label).toBe("Unknown");
        // The fixed Pfizer columns stay at zero.
        expect(table.rows.find((r) => r.vaccineName === "pfizer_12-64")!.countsByDay["2026-08-17"]).toBe(0);
        expect(table.rows.find((r) => r.vaccineName === "pfizer_65+")!.countsByDay["2026-08-17"]).toBe(0);
      });

      it("a Pfizer 3-11 composite (not one of Pfizer's two fixed columns) becomes its own extra column, never hidden", () => {
        const table = buildAppointmentTable(
          [{ date: "2026-08-17", vaccineName: "COVID · Pfizer · 3-11", count: 1 }],
          DAYS
        );

        const extra = table.columns.find((c) => c.vaccineName === "COVID · Pfizer · 3-11");
        expect(extra).toEqual({
          vaccineName: "COVID · Pfizer · 3-11",
          group: "COVID",
          subgroup: "Pfizer",
          label: "3-11",
        });
      });

      it("does not create an extra column at all when no unusual combo is present (renders only when nonzero)", () => {
        const table = buildAppointmentTable(
          [{ date: "2026-08-17", vaccineName: "COVID · Pfizer · 65+", count: 1 }],
          DAYS
        );
        expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
      });
    });

    it("sorts multiple extra columns alphabetically by label, deterministically", () => {
      const table = buildAppointmentTable(
        [
          { date: "2026-08-17", vaccineName: "Zebra Vaccine", count: 1 },
          { date: "2026-08-17", vaccineName: "Alpha Vaccine", count: 1 },
        ],
        DAYS
      );

      const extraLabels = table.columns.slice(FIXED_COLUMN_IDS.length).map((c) => c.label);
      expect(extraLabels).toEqual(["Alpha Vaccine", "Zebra Vaccine"]);
    });
  });

  it("Total is moved second conceptually — grandTotal/dailyTotals sum across ALL columns, fixed and extra alike", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "MMR-II", count: 2 },
      { date: "2026-08-17", vaccineName: "Something Unmatched", count: 3 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.dailyTotals["2026-08-17"]).toBe(5);
    expect(table.grandTotal).toBe(5);
  });

  it("ignores a count entry whose date falls outside the requested day columns", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "MMR-II", count: 2 },
      { date: "2026-09-01", vaccineName: "MMR-II", count: 99 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    const row = table.rows.find((r) => r.vaccineName === "mmr")!;
    expect(row.countsByDay).toEqual({ "2026-08-17": 2, "2026-08-18": 0, "2026-08-19": 0 });
    expect(row.total).toBe(2);
    expect(table.grandTotal).toBe(2);
  });

  it("sums multiple entries for the same (resolved column, day) pair rather than overwriting", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "RSV", count: 2 },
      { date: "2026-08-17", vaccineName: "Abrysvo", count: 3 },
    ];

    const table = buildAppointmentTable(counts, DAYS);
    const row = table.rows.find((r) => r.vaccineName === "rsv")!;

    expect(row.countsByDay["2026-08-17"]).toBe(5);
    expect(row.total).toBe(5);
    expect(table.dailyTotals["2026-08-17"]).toBe(5);
  });

  it("puts two distinct vaccines from the same multi-vaccine appointment into separate columns", () => {
    // aggregateAppointmentCounts (lib/acuity-client.ts) already splits a
    // single appointment's vaccineNames into separate {date, vaccineName}
    // entries — this just confirms the table builder doesn't collapse
    // them back together.
    const counts = [
      { date: "2026-08-17", vaccineName: "Flu · 3-64", count: 1 },
      { date: "2026-08-17", vaccineName: "COVID · Pfizer · 65+", count: 1 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows.find((r) => r.vaccineName === "flu_3-64")!.countsByDay["2026-08-17"]).toBe(1);
    expect(table.rows.find((r) => r.vaccineName === "pfizer_65+")!.countsByDay["2026-08-17"]).toBe(1);
    // Both columns count the one shared appointment day, but the daily
    // total is NOT double-counted per-appointment — it's a sum of the
    // (already-split) count entries, same as any other two rows.
    expect(table.dailyTotals["2026-08-17"]).toBe(2);
  });

  it("falls back to appointmentTypeName (old pre-pivot cache shape) instead of an 'undefined' column", () => {
    const counts = [{ date: "2026-08-17", appointmentTypeName: "Vaccine Appointment", count: 4 }] as never;

    const table = buildAppointmentTable(counts, DAYS);

    const extra = table.rows.find((r) => r.vaccineName === "Vaccine Appointment");
    expect(extra).toEqual({
      vaccineName: "Vaccine Appointment",
      countsByDay: { "2026-08-17": 4, "2026-08-18": 0, "2026-08-19": 0 },
      total: 4,
    });
  });

  it("falls back to 'Unknown' rather than throwing when neither vaccineName nor appointmentTypeName is present", () => {
    const counts = [{ date: "2026-08-17", count: 1 }] as never;

    const table = buildAppointmentTable(counts, DAYS);

    const extra = table.rows.find((r) => r.vaccineName === "Unknown");
    expect(extra).toEqual({
      vaccineName: "Unknown",
      countsByDay: { "2026-08-17": 1, "2026-08-18": 0, "2026-08-19": 0 },
      total: 1,
    });
  });

  it("columns and rows stay index-aligned end to end (fixed + extra)", () => {
    const counts = [
      { date: "2026-08-17", vaccineName: "MMR-II", count: 1 },
      { date: "2026-08-17", vaccineName: "Something Unmatched", count: 1 },
    ];

    const table = buildAppointmentTable(counts, DAYS);

    expect(table.rows.map((r) => r.vaccineName)).toEqual(table.columns.map((c: AppointmentTableColumn) => c.vaccineName));
  });
});

// V-T-schedule-table ROUND 2 follow-up (Will 2026-09-05): the ordering
// route needs a matchable (non-composite) string to look a COVID/Flu
// count up in the vaccine catalog — see this function's doc comment in
// lib/appointment-table.ts for the full "why" and the documented
// brand-ambiguity tradeoffs.
describe("compositeNameToMatchableBase", () => {
  it("strips the age segment from a COVID composite, keeping the brand", () => {
    expect(compositeNameToMatchableBase("COVID · Pfizer · 65+")).toBe("COVID Pfizer");
    expect(compositeNameToMatchableBase("COVID · Moderna · 3-11")).toBe("COVID Moderna");
    expect(compositeNameToMatchableBase("COVID · Moderna · 12-64")).toBe("COVID Moderna");
  });

  it("drops the brand entirely for the brandless 'Any' composite", () => {
    expect(compositeNameToMatchableBase("COVID · Any · Unknown")).toBe("COVID");
    expect(compositeNameToMatchableBase("COVID · Any · 12-64")).toBe("COVID");
  });

  it("strips the age segment from a Flu composite — Flu has no brand to keep", () => {
    expect(compositeNameToMatchableBase("Flu · 3-64")).toBe("Flu");
    expect(compositeNameToMatchableBase("Flu · 65+")).toBe("Flu");
    expect(compositeNameToMatchableBase("Flu · Unknown")).toBe("Flu");
  });

  it("passes a non-composite (already plain) name through untouched", () => {
    expect(compositeNameToMatchableBase("MMR-II")).toBe("MMR-II");
    expect(compositeNameToMatchableBase("Shingrix")).toBe("Shingrix");
    expect(compositeNameToMatchableBase("Some Unmatched Vaccine")).toBe("Some Unmatched Vaccine");
  });
});
