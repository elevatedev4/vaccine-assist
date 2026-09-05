import { describe, expect, it } from "vitest";
import {
  buildAppointmentTable,
  buildColumnTotals,
  computeTodayAndNext7Summaries,
  compositeNameToMatchableBase,
  type AppointmentTableColumn,
} from "@/lib/appointment-table";

const DAYS = ["2026-08-17", "2026-08-18", "2026-08-19"];

// The 19 fixed columns, in Will's exact mockup order (V-T-schedule-table
// ROUND 2, regrouped ROUND 4 per his V-T9 answer — "combine the 'any'
// into the Pfizer" and "group them into 'Common' and 'Other'"), always
// present regardless of input — see FIXED_COLUMNS in
// lib/appointment-table.ts. Used below to assert both the always-zero
// case and that the ordering never drifts.
const FIXED_COLUMN_IDS = [
  "pfizer_3-11",
  "pfizer_12-64",
  "pfizer_65+",
  "moderna_3-11",
  "moderna_12-64",
  "moderna_65+",
  "flu_3-64",
  "flu_65+",
  "flu_unknown",
  "shingles",
  "pneumonia",
  "tetanus",
  "rsv",
  "hpv",
  "meningitis",
  "typhoid",
  "mmr",
  "hepA",
  "hepB",
];

function zeroedDays(): Record<string, number> {
  return Object.fromEntries(DAYS.map((d) => [d, 0]));
}

describe("buildAppointmentTable", () => {
  describe("fixed columns (V-T-schedule-table ROUND 2, regrouped ROUND 4)", () => {
    it("renders all 19 fixed columns, in Will's exact order, even when counts is empty", () => {
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

      expect(byId.get("pfizer_3-11")).toEqual({
        vaccineName: "pfizer_3-11",
        group: "COVID",
        subgroup: "Pfizer",
        label: "3-11",
      });
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
      expect(byId.get("flu_3-64")).toEqual({ vaccineName: "flu_3-64", group: "Flu", subgroup: null, label: "3-64" });
      expect(byId.get("flu_unknown")).toEqual({
        vaccineName: "flu_unknown",
        group: "Flu",
        subgroup: null,
        label: "Unk",
      });
      // "Common" (Will, V-T9): Shingles, Pneumonia, Tdap, RSV, HPV.
      expect(byId.get("shingles")).toEqual({
        vaccineName: "shingles",
        group: "Common",
        subgroup: null,
        label: "Shingles",
      });
      // Short chart labels, not form wording (Will: "Don't write Tetanus/
      // whooping cough, just write Tdap").
      expect(byId.get("tetanus")).toEqual({ vaccineName: "tetanus", group: "Common", subgroup: null, label: "Tdap" });
      expect(byId.get("hpv")).toEqual({ vaccineName: "hpv", group: "Common", subgroup: null, label: "HPV" });
      // "Other" (Will, V-T9): everything else.
      expect(byId.get("meningitis")).toEqual({
        vaccineName: "meningitis",
        group: "Other",
        subgroup: null,
        label: "Meningitis",
      });
      expect(byId.get("hepA")).toEqual({ vaccineName: "hepA", group: "Other", subgroup: null, label: "Hep A" });
    });

    it("puts the 5 Common columns together in Will's exact order, and the 5 Other columns together after them", () => {
      const table = buildAppointmentTable([], DAYS);
      const commonLabels = table.columns.filter((c) => c.group === "Common").map((c) => c.label);
      const otherLabels = table.columns.filter((c) => c.group === "Other").map((c) => c.label);

      expect(commonLabels).toEqual(["Shingles", "Pneumonia", "Tdap", "RSV", "HPV"]);
      expect(otherLabels).toEqual(["Meningitis", "Typhoid", "MMR", "Hep A", "Hep B"]);
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

  describe("ROUND 4: COVID 'Any' brand merges into Pfizer", () => {
    it("routes an Any-brand 12-64 count onto the pfizer_12-64 fixed column", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "COVID · Any · 12-64", count: 4 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === "pfizer_12-64")!;
      expect(row.countsByDay["2026-08-17"]).toBe(4);
      expect(row.total).toBe(4);
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    it("routes an Any-brand 65+ count onto the pfizer_65+ fixed column", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "COVID · Any · 65+", count: 2 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === "pfizer_65+")!;
      expect(row.countsByDay["2026-08-17"]).toBe(2);
    });

    it("routes an Any-brand 3-11 count onto the (new) pfizer_3-11 fixed column, NOT a separate 'any' column", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "COVID · Any · 3-11", count: 1 }], DAYS);
      const row = table.rows.find((r) => r.vaccineName === "pfizer_3-11")!;
      expect(row.countsByDay["2026-08-17"]).toBe(1);
      expect(table.columns.some((c) => c.subgroup === "Any")).toBe(false);
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length);
    });

    it("sums a native Pfizer count and a merged Any count in the SAME fixed column", () => {
      const table = buildAppointmentTable(
        [
          { date: "2026-08-17", vaccineName: "COVID · Pfizer · 12-64", count: 3 },
          { date: "2026-08-17", vaccineName: "COVID · Any · 12-64", count: 5 },
        ],
        DAYS
      );
      const row = table.rows.find((r) => r.vaccineName === "pfizer_12-64")!;
      expect(row.countsByDay["2026-08-17"]).toBe(8);
    });

    it("does NOT merge Any into Moderna — Moderna columns are unaffected by the merge", () => {
      const table = buildAppointmentTable([{ date: "2026-08-17", vaccineName: "COVID · Any · 65+", count: 9 }], DAYS);
      const modernaRow = table.rows.find((r) => r.vaccineName === "moderna_65+")!;
      expect(modernaRow.countsByDay["2026-08-17"]).toBe(0);
    });

    it("merges an Any-brand Unknown-age count AND a native Pfizer Unknown-age count into ONE extra column (Any-unknown -> Pfizer-unknown)", () => {
      const table = buildAppointmentTable(
        [
          { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 2 },
          { date: "2026-08-17", vaccineName: "COVID · Pfizer · Unknown", count: 3 },
        ],
        DAYS
      );

      // Exactly ONE extra column, not two — they merge into the same
      // synthetic id.
      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
      const extra = table.columns.find((c) => c.group === "COVID" && c.subgroup === "Pfizer" && c.label === "Unknown")!;
      expect(extra).toBeDefined();
      const row = table.rows.find((r) => r.vaccineName === extra.vaccineName)!;
      expect(row.countsByDay["2026-08-17"]).toBe(5);
    });

    it("a Moderna Unknown-age count is NOT merged with a Pfizer/Any Unknown-age count (separate extra columns)", () => {
      const table = buildAppointmentTable(
        [
          { date: "2026-08-17", vaccineName: "COVID · Moderna · Unknown", count: 1 },
          { date: "2026-08-17", vaccineName: "COVID · Any · Unknown", count: 1 },
        ],
        DAYS
      );

      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 2);
      const modernaExtra = table.columns.find((c) => c.subgroup === "Mod")!;
      const pfizerExtra = table.columns.find((c) => c.subgroup === "Pfizer" && !FIXED_COLUMN_IDS.includes(c.vaccineName))!;
      expect(modernaExtra).toBeDefined();
      expect(pfizerExtra).toBeDefined();
      expect(modernaExtra.vaccineName).not.toBe(pfizerExtra.vaccineName);
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
      ["Boostrix", "tetanus"],
      ["Adacel", "tetanus"],
      ["Tenivac", "tetanus"],
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

    it("appends an unrecognized vaccine name as its own extra column after the fixed set (under 'Other'), never hiding it", () => {
      const table = buildAppointmentTable(
        [{ date: "2026-08-17", vaccineName: "Brand New Vaccine 2027", count: 5 }],
        DAYS
      );

      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
      const extraColumn = table.columns[table.columns.length - 1];
      expect(extraColumn).toEqual({
        vaccineName: "Brand New Vaccine 2027",
        group: "Other",
        subgroup: null,
        label: "Brand New Vaccine 2027",
      });
      const extraRow = table.rows[table.rows.length - 1];
      expect(extraRow.countsByDay["2026-08-17"]).toBe(5);
      expect(extraRow.total).toBe(5);
    });

    // Per-brand Unknown-age columns and any other unusual COVID brand/age
    // combo Will's mockup doesn't list (currently: either brand's Unknown
    // age) are NOT part of the fixed set — they become extra columns that
    // only appear when they actually have a count, which IS the "render
    // only when nonzero" behavior (requirement 1b) — one mechanism serves
    // both.
    describe("unusual COVID combos render only when nonzero (extra-column mechanism)", () => {
      it("a brand's Unknown-age composite becomes its own extra column, not a fixed one, positioned adjacent to the COVID group (not appended at the very end)", () => {
        const table = buildAppointmentTable(
          [{ date: "2026-08-17", vaccineName: "COVID · Pfizer · Unknown", count: 1 }],
          DAYS
        );

        expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
        const extra = table.columns.find((c) => c.group === "COVID" && c.subgroup === "Pfizer" && c.label === "Unknown")!;
        expect(extra).toBeDefined();
        // Review fix (2026-09-05), still true post-ROUND-4: sits
        // immediately after the last fixed COVID column ("moderna_65+",
        // index 5) — NOT at the very end of the table — so it stays part
        // of one contiguous COVID header run.
        expect(table.columns[6].vaccineName).toBe(extra.vaccineName);
        // The fixed Pfizer columns stay at zero.
        expect(table.rows.find((r) => r.vaccineName === "pfizer_12-64")!.countsByDay["2026-08-17"]).toBe(0);
        expect(table.rows.find((r) => r.vaccineName === "pfizer_65+")!.countsByDay["2026-08-17"]).toBe(0);
      });

      it("a Moderna Unknown-age composite becomes its own extra column, never hidden", () => {
        const table = buildAppointmentTable(
          [{ date: "2026-08-17", vaccineName: "COVID · Moderna · Unknown", count: 1 }],
          DAYS
        );

        const extra = table.columns.find((c) => c.subgroup === "Mod" && !FIXED_COLUMN_IDS.includes(c.vaccineName));
        expect(extra).toEqual({
          vaccineName: "covid_moderna_unknown",
          group: "COVID",
          subgroup: "Mod",
          label: "Unknown",
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

    // Review fix (2026-09-05), generalized ROUND 4 over all 4 groups: a
    // flat alphabetical sort over ALL extras could scatter a COVID extra
    // away from its own group's fixed run whenever some unrelated extra's
    // label happened to sort between them — e.g. "COVID · Pfizer · 3-11"
    // and an ungrouped "Zzz Vaccine" both sorting after the fixed set,
    // with the ungrouped one landing BETWEEN two COVID columns. That
    // splits the COVID group into non-adjacent runs, which makes
    // buildHeaderRows (app/appointments/page.tsx) render more than one
    // spanning "COVID" header cell instead of a single contiguous one.
    // Extras are bucketed by group first, then inserted immediately
    // adjacent to their own group's fixed run — "Other" being the LAST
    // group in FIXED_COLUMNS is what puts a genuinely-unmatched extra at
    // the very end, not a special case.
    describe("extras sort adjacent to their own group's run, not scattered by a flat alphabetical sort", () => {
      it("keeps two unusual COVID combos and a Moderna-Unknown combo in ONE contiguous COVID run, with an unrelated extra pushed to the very end", () => {
        const counts = [
          { date: "2026-08-17", vaccineName: "COVID · Pfizer · Unknown", count: 1 },
          { date: "2026-08-17", vaccineName: "COVID · Moderna · Unknown", count: 1 },
          { date: "2026-08-17", vaccineName: "Some Brand New Vaccine", count: 1 },
        ];

        const table = buildAppointmentTable(counts, DAYS);

        // 19 fixed + 2 COVID extras + 1 ungrouped ("Other") extra.
        expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 3);

        // Every COVID-group column (fixed AND extra) forms ONE contiguous
        // run — no other group's column sits between any two of them.
        // This is exactly what lets buildHeaderRows render a single
        // spanning "COVID" header cell.
        const covidIndices = table.columns.reduce<number[]>((indices, column, index) => {
          if (column.group === "COVID") indices.push(index);
          return indices;
        }, []);
        expect(covidIndices).toHaveLength(8); // 6 fixed + 2 extras
        for (let i = 1; i < covidIndices.length; i++) {
          expect(covidIndices[i]).toBe(covidIndices[i - 1] + 1);
        }

        // The two extras sort alphabetically by label — both are labeled
        // "Unknown" here, so they land in insertion-stable order — right
        // after the 6 fixed COVID columns (index 5 = "moderna_65+") and
        // before the first fixed Flu column.
        expect(table.columns[6].group).toBe("COVID");
        expect(table.columns[7].group).toBe("COVID");
        expect(table.columns[8].vaccineName).toBe("flu_3-64");

        // The unrelated (Other-group, genuinely unmatched) extra sits at
        // the very end, after the full fixed set AND the grouped extras.
        expect(table.columns[table.columns.length - 1].vaccineName).toBe("Some Brand New Vaccine");
      });

      it("keeps a Flu extra adjacent to the fixed Flu columns too", () => {
        // Not a realistic composite in practice (Flu's 3 buckets are all
        // fixed columns already) but exercises the same adjacency
        // mechanism generically for the Flu group, not just COVID.
        const counts = [
          { date: "2026-08-17", vaccineName: "Flu · 3-64", count: 1 }, // fixed
          { date: "2026-08-17", vaccineName: "Zzz Unrelated Vaccine", count: 1 }, // Other extra
        ];

        const table = buildAppointmentTable(counts, DAYS);
        const fluIndices = table.columns.reduce<number[]>((indices, column, index) => {
          if (column.group === "Flu") indices.push(index);
          return indices;
        }, []);
        expect(fluIndices).toHaveLength(3); // all 3 fixed Flu columns, none scattered
        for (let i = 1; i < fluIndices.length; i++) {
          expect(fluIndices[i]).toBe(fluIndices[i - 1] + 1);
        }
        // Ungrouped ("Other") extra still lands at the very end.
        expect(table.columns[table.columns.length - 1].vaccineName).toBe("Zzz Unrelated Vaccine");
      });
    });

    // Legacy cache self-heal (review fix, 2026-09-05): "12+" was the
    // COVID age-bucket label BEFORE the 65+ split shipped (ROUND 2's
    // same-day amendment). A row still sitting in acuity_poll_cache with
    // the old label doesn't match COVID_COMPOSITE_PATTERN (which only
    // recognizes today's 3-11/12-64/65+/Unknown buckets) — it must
    // degrade gracefully to a plain extra column instead of crashing or
    // silently vanishing, and self-heals within one poll TTL (~5 min)
    // once Acuity is re-fetched and re-aggregated in the current shape.
    it("renders a legacy cached 'COVID · Pfizer · 12+' (pre-65+-split bucket label) as a plain 'Other' extra column without crashing", () => {
      const table = buildAppointmentTable(
        [{ date: "2026-08-17", vaccineName: "COVID · Pfizer · 12+", count: 6 }],
        DAYS
      );

      expect(table.columns).toHaveLength(FIXED_COLUMN_IDS.length + 1);
      const extra = table.columns.find((c) => c.vaccineName === "COVID · Pfizer · 12+");
      expect(extra).toEqual({
        vaccineName: "COVID · Pfizer · 12+",
        group: "Other",
        subgroup: null,
        label: "COVID · Pfizer · 12+",
      });
      const row = table.rows.find((r) => r.vaccineName === "COVID · Pfizer · 12+")!;
      expect(row.countsByDay["2026-08-17"]).toBe(6);
      expect(row.total).toBe(6);
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
// brand-ambiguity tradeoffs. UNCHANGED by ROUND 4's table-display merge —
// this operates on the raw composite name straight out of the cache,
// which still says "Any" (see resolveColumn's ROUND 4 comment for why the
// merge is display-layer only).
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

// ROUND 4 (V-T9 answer): "add a 'total vaccines remaining after today'
// row that sums up all the future appointments too" — buildColumnTotals
// is the pure per-column aggregation the "After today" summary is built
// from (see lib/acuity-future-summary.ts's fetchAfterTodaySummary for the
// chunked-fetch orchestration that produces its input).
describe("buildColumnTotals", () => {
  it("resolves counts through the same column mapping as buildAppointmentTable, with no `days` dimension", () => {
    const totals = buildColumnTotals([
      { date: "2026-10-01", vaccineName: "COVID · Pfizer · 65+", count: 3 },
      { date: "2026-10-08", vaccineName: "COVID · Any · 65+", count: 2 }, // merges into the same column
      { date: "2026-10-15", vaccineName: "Shingrix", count: 1 },
    ]);

    expect(totals.byColumnId["pfizer_65+"]).toBe(5);
    expect(totals.byColumnId["shingles"]).toBe(1);
    expect(totals.total).toBe(6);
  });

  it("returns an empty totals object for an empty input, never throwing", () => {
    expect(buildColumnTotals([])).toEqual({ byColumnId: {}, total: 0 });
  });

  it("sums repeated dates for the same column across many windows", () => {
    const totals = buildColumnTotals([
      { date: "2026-10-01", vaccineName: "Flu · 3-64", count: 4 },
      { date: "2026-10-08", vaccineName: "Flu · 3-64", count: 6 },
      { date: "2026-10-15", vaccineName: "Flu · 3-64", count: 1 },
    ]);
    expect(totals.byColumnId["flu_3-64"]).toBe(11);
    expect(totals.total).toBe(11);
  });
});

// ROUND 4 (V-T9 answer): "So the rows should be 'Today' 'Next 7 days'
// 'After today' then the breakdown for the next today and the following
// 7 days."
describe("computeTodayAndNext7Summaries", () => {
  const EIGHT_DAYS = [
    "2026-09-05", // today
    "2026-09-06",
    "2026-09-07",
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11", // today+6 — last day counted in "Next 7 days"
    "2026-09-12", // today+7 — NOT counted in "Next 7 days", still a daily row
  ];

  it("'Today' is exactly table.days[0]'s counts, per column and total", () => {
    const counts = [
      { date: "2026-09-05", vaccineName: "MMR-II", count: 3 },
      { date: "2026-09-06", vaccineName: "MMR-II", count: 99 }, // must NOT bleed into Today
    ];
    const table = buildAppointmentTable(counts, EIGHT_DAYS);

    const { today } = computeTodayAndNext7Summaries(table);
    expect(today.label).toBe("Today");
    expect(today.byColumnId["mmr"]).toBe(3);
    expect(today.total).toBe(3);
  });

  it("'Next 7 days' sums days[0..6] (today through today+6) — 7 calendar days, NOT the 8th day", () => {
    const counts = [
      { date: "2026-09-05", vaccineName: "MMR-II", count: 1 }, // today
      { date: "2026-09-11", vaccineName: "MMR-II", count: 2 }, // today+6, last day IN the window
      { date: "2026-09-12", vaccineName: "MMR-II", count: 100 }, // today+7, OUTSIDE the window
    ];
    const table = buildAppointmentTable(counts, EIGHT_DAYS);

    const { next7 } = computeTodayAndNext7Summaries(table);
    expect(next7.label).toBe("Next 7 days");
    expect(next7.byColumnId["mmr"]).toBe(3); // 1 + 2, NOT +100
    expect(next7.total).toBe(3);
  });

  it("'Today' and 'Next 7 days' agree with table.dailyTotals for their respective day sets", () => {
    const counts = [
      { date: "2026-09-05", vaccineName: "RSV", count: 2 },
      { date: "2026-09-06", vaccineName: "HPV Vaccine", count: 4 },
    ];
    const table = buildAppointmentTable(counts, EIGHT_DAYS);
    const { today, next7 } = computeTodayAndNext7Summaries(table);

    expect(today.total).toBe(table.dailyTotals["2026-09-05"]);
    expect(next7.total).toBe(
      EIGHT_DAYS.slice(0, 7).reduce((sum, day) => sum + table.dailyTotals[day], 0)
    );
  });

  it("degrades to an all-zero Today row instead of throwing when table.days is empty", () => {
    const table = buildAppointmentTable([], []);
    const { today, next7 } = computeTodayAndNext7Summaries(table);
    expect(today.total).toBe(0);
    expect(next7.total).toBe(0);
  });

  it("every fixed column id appears in both summaries' byColumnId, zeroed if no count landed there", () => {
    const table = buildAppointmentTable([], EIGHT_DAYS);
    const { today, next7 } = computeTodayAndNext7Summaries(table);
    for (const column of table.columns) {
      expect(today.byColumnId[column.vaccineName]).toBe(0);
      expect(next7.byColumnId[column.vaccineName]).toBe(0);
    }
  });
});
