import type { AppointmentTableColumn } from "@/lib/appointment-table";
import { heatmapCellBackground } from "@/lib/appointment-table";
import { computePocTestHeatmapMaxes, isPocTestTableEmpty, type PocTestTable } from "@/lib/poc-test-table";

// Shared presentation for the pivoted schedule table (vaccine columns across
// the top, dates down the left). Extracted verbatim from
// app/appointments/page.tsx so the 7-day view and the date-range view
// (app/appointments/range/page.tsx) render the identical layout; the pivot
// itself still lives in lib/appointment-table.ts.

// Total header-row depth: COVID needs 3 (group "COVID" -> brand "Pfizer"/
// "Moderna" -> age "3-11"/"12-64"/"65+" — ROUND 4 merges "Any" into "Pfizer",
// see lib/appointment-table.ts's resolveColumn); every other column
// (Flu/Common/Other) collapses into fewer rows via rowSpan (see
// buildHeaderRows below) but the <thead> itself always has this many
// <tr>s.
export const HEADER_ROW_COUNT = 3;

// Column widths (ROUND 6, V-T12 answer, Will 2026-09-05, verbatim: "on my
// 24" monitor, it spreads out the table to make it fill space. Just make
// it take up the amount of space it should take up. Don't add extra
// inside the cells to fill the extra space.") — every vaccine (data)
// column gets the SAME small fixed pixel width regardless of viewport, so
// the table stays chart-like and compact instead of table-layout: fixed
// stretching equal-width columns out to fill a wide monitor. The date
// column is intentionally left with no explicit width (see the <colgroup>
// in AppointmentsPage) so it sizes to its own content ("Mon 9/5").
export const DATA_COL_WIDTH_PX = 56;
// Total is a data-shaped column too (needs a fixed width, not "auto" like
// the date labels) but slightly wider than a vaccine column since a
// 7-day total can run to 3 digits.
export const TOTAL_COL_WIDTH_PX = 60;

export const styles = {
  main: { fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640 },
  // No maxWidth here on purpose (V-T-schedule-table, Will 2026-09-04:
  // "everything visible at once, NOT scrollable") — the table page uses
  // the full viewport width instead of being squeezed into a 960px column
  // and forced to scroll horizontally to show the rest of the columns.
  // V-T11 (Will, verbatim): "Make the spacing even tighter. There is no
  // need to have so much dead space." Tightened page padding on top of the
  // ROUND 2 full-width layout.
  mainWide: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem" },
  field: { display: "block", width: "100%", marginBottom: "0.75rem", padding: "0.5rem", boxSizing: "border-box" },
  label: { display: "block", fontWeight: 600, marginBottom: "0.25rem" },
  button: { padding: "0.5rem 1rem", marginRight: "0.5rem" },
  error: { color: "#b00020" },
  warning: { color: "#8a5300", background: "#fff4e0", padding: "0.5rem 0.75rem", borderRadius: 4 },
  muted: { color: "#555", fontSize: "0.875rem" },
  // V-T11: page heading and action rows above the table get their default
  // browser margins collapsed down to a tight, deliberate amount instead —
  // that dead air was most of the gap between sign-in bar and the table.
  heading: { margin: "0.5rem 0 0.5rem" },
  actionsRow: { margin: "0 0 0.35rem" },
  autoRefreshNote: { color: "#555", fontSize: "0.875rem", margin: "0 0 0.5rem" },
  // Compact "read as a chart, not a document" table (V-T-schedule-table
  // ROUND 2, Will 2026-09-05: "make it look like a chart" — minimal
  // font/padding; V-T11: padding tightened further and header rows
  // shortened — "There is no need to have so much dead space"). ROUND 6
  // (V-T12): deliberately NO width: 100%/tableLayout: "fixed" here anymore
  // — those stretched every column to fill a wide monitor. The table now
  // sizes to its own content (natural width); each data <col>'s explicit
  // pixel width (see the <colgroup> below) is what keeps the columns
  // compact and equal-ish, not a percentage of the viewport.
  table: { borderCollapse: "collapse", fontSize: "0.72rem" },
  thType: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap",
  },
  // Group header (row 1 of 3): one cell spanning "COVID" or "Flu"'s whole
  // sub-column run — see thSub (row 2) and thLeaf (final row).
  thGroup: {
    textAlign: "center",
    padding: "0.1rem 0.25rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  // Brand sub-header (row 2, COVID only) — "Pfizer" / "Moderna" / "Any".
  // Kept even shorter than the other header rows (V-T11: "trim header row
  // heights") since it's the middle row of COVID's 3-level nested header.
  thSub: {
    textAlign: "center",
    padding: "0.05rem 0.25rem",
    borderBottom: "1px solid #ddd",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  // Leaf age header (row 2 for Flu, row 3 for COVID, or the single row
  // for a plain/non-grouped column via rowSpan).
  thLeaf: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    borderBottom: "2px solid #ccc",
    fontWeight: 500,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  td: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee" },
  tdZero: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", color: "#bbb" },
  tdType: { textAlign: "left", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 500 },
  totalCell: { textAlign: "right", padding: "0.1rem 0.25rem", borderBottom: "1px solid #eee", fontWeight: 600 },
  // Summary rows (Today / Next 7 days / After today — V-T9 answer, Will
  // 2026-09-05): bold, sit directly under the header. Only the LAST of
  // the three gets the heavier bottom border that separates the summary
  // block from the daily-breakdown rows below it — see summaryRowStyles
  // in AppointmentsPage.
  sumRowLabel: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "1px solid #ddd",
  },
  sumRowCell: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "1px solid #ddd",
  },
  sumRowLabelLast: {
    textAlign: "left",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  sumRowCellLast: {
    textAlign: "right",
    padding: "0.1rem 0.25rem",
    fontWeight: 700,
    borderBottom: "2px solid #ccc",
  },
  // Bare fallback only — does nothing when the (now compact, full-width)
  // table already fits, only kicks in a scrollbar if a viewport is truly
  // narrower than the table (e.g. a small laptop screen).
  tableWrap: { overflowX: "auto", marginTop: "0.4rem" },
  // Point-of-care testing table (V-T-poc-testing, Will 2026-09-08 follow-up
  // fix, verbatim: "Add it below to the right of the vaccine appointment
  // table") — the vaccine table (~1300px wide) renders full-width on its
  // OWN row now (a flex row alongside it wrapped once the vaccine table
  // alone exceeds most viewport widths). BELOW that, this flex row holds
  // Hourly breakdown (left) and Point-of-care tests (right), 32px gap,
  // wrapping the POC table below Hourly breakdown once the viewport is too
  // narrow to fit both side-by-side. `alignItems: "flex-start"` keeps the
  // shorter table pinned to the top rather than vertically centered
  // against the taller one.
  bottomTablesRow: { display: "flex", flexWrap: "wrap", gap: "2rem", alignItems: "flex-start" },
  twoTableCol: { minWidth: 0 },
  // Hourly table (V-T-hourly-table, Will 2026-09-05) — "match the main
  // table exactly" for cells/borders/width, but a PLAIN header (no
  // per-group color) since every column is just an hour, not a vaccine
  // group. Reuses styles.thLeaf/td/tdZero/totalCell for the actual cell
  // look; only the section heading/toggle/note styles below are new.
  hourlyHeading: { margin: "1.25rem 0 0.35rem" },
  toggleRow: { display: "flex", alignItems: "center", gap: "0.4rem", margin: "0 0 0.4rem" },
  toggleButton: {
    padding: "0.3rem 0.7rem",
    fontSize: "0.8rem",
    border: "1px solid #999",
    background: "#fff",
    cursor: "pointer",
    borderRadius: 4,
  },
  toggleButtonActive: {
    padding: "0.3rem 0.7rem",
    fontSize: "0.8rem",
    border: "1px solid #1e6b3a",
    background: "#16a34a",
    color: "#fff",
    cursor: "pointer",
    borderRadius: 4,
    fontWeight: 600,
  },
  // Small "+N outside 8-6" annotation under a day's Total cell (JUDGMENT
  // CALL — see HourlyBreakdownRow.outsideTotal's doc comment in
  // lib/appointment-table.ts): deliberately muted/small so it reads as a
  // footnote on the Total, not a second number competing with it.
  outsideNote: { display: "block", fontSize: "0.62rem", fontWeight: 400, color: "#777", whiteSpace: "nowrap" },
  // V-T-booking-activity (Will, 2026-09-05/07): "collapsed by default
  // behind a visually de-emphasized link at the BOTTOM of the page" — a
  // plain-text toggle, deliberately with none of styles.toggleButton's
  // button chrome (no border/background/padding box), small and muted so
  // it reads as a footnote link rather than competing with the two real
  // tables above it.
  activityLinkRow: { margin: "1.5rem 0 0" },
  activityToggleLink: {
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    fontSize: "0.75rem",
    color: "#888",
    textDecoration: "underline",
    cursor: "pointer",
  },
  activitySection: { marginTop: "0.5rem" },
  activityCaption: { color: "#555", fontSize: "0.8rem", margin: "0 0 0.4rem" },
} as const;

/**
 * Per-group header tints (V-T9 answer, Will 2026-09-05: "I need vertical
 * borders for the columns, and color differentiation between covid, flu,
 * and everything else"). Subtle, professional (this is a data tool, not a
 * poster) — light hues, dark default text stays fully readable on top of
 * them, one family per group: COVID blue, Flu amber, Common green, Other
 * violet.
 *
 * ROUND 6 (V-T12 answer, verbatim): "Remove the color of the data portions
 * of the table (leave the headings colored). Instead, color the background
 * a gradient based on the # of vaccines scheduled." So `data` tints are
 * GONE — every data cell's background now comes from
 * heatmapCellBackground (lib/appointment-table.ts) instead, and only the
 * group/sub-group/leaf HEADER cells still use this map (see
 * groupHeaderStyle/subHeaderStyle/leafHeaderStyle below).
 */
export const GROUP_COLORS: Record<AppointmentTableColumn["group"], { header: string }> = {
  COVID: { header: "#dbe7f9" },
  Flu: { header: "#f9e2cc" },
  Common: { header: "#d7eede" },
  Other: { header: "#e3daf3" },
};

// V-T9: "I need vertical borders for the columns" — a 1px divider on the
// LEFT edge of every leaf/data cell, so every vaccine column (not just
// every group) reads as visually distinct. Group/sub-group header cells
// (which span multiple leaf columns) only need this same left border
// once, at the start of their own span — see groupHeaderStyle/
// subHeaderStyle below.
export const COLUMN_DIVIDER = { borderLeft: "1px solid #c9c9c9" } as const;

export function groupHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thGroup, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

export function subHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thSub, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

export function leafHeaderStyle(group: AppointmentTableColumn["group"]) {
  return { ...styles.thLeaf, ...COLUMN_DIVIDER, background: GROUP_COLORS[group].header };
}

// ROUND 6: `background` comes from heatmapCellBackground
// (lib/appointment-table.ts), computed by the caller against whichever of
// the two independent scales the row belongs to (see dailyScaleMax /
// weeklyScaleMax in AppointmentsPage) — no more per-GROUP tint on data
// cells, only on headers (groupHeaderStyle/subHeaderStyle/leafHeaderStyle).
// Cell text is always the style's own default (black-ish for a nonzero
// cell, dimmed grey for a zero one, per styles.td/tdZero) — no text-color
// override (review fix, 2026-09-05: HEATMAP_MAX_INTENSITY in
// lib/appointment-table.ts is tuned so black text stays WCAG-AA-legible
// at every ratio, so no switch is needed; see that constant's doc
// comment).
export function dataCellStyle(isZero: boolean, background: string) {
  return { ...(isZero ? styles.tdZero : styles.td), ...COLUMN_DIVIDER, background };
}

export function summaryCellStyle(isLastSummaryRow: boolean, background: string) {
  return { ...(isLastSummaryRow ? styles.sumRowCellLast : styles.sumRowCell), ...COLUMN_DIVIDER, background };
}

// Third heatmap scale (Will's follow-up, verbatim: "Add heatmap to the
// daily totals for the upcoming forecast too") — paints the Total column
// for the Today summary row and every daily-breakdown row against
// `totalsScaleMax` (see computeHeatmapMaxes). Deliberately NO
// COLUMN_DIVIDER here (the Total column has never had a left border,
// unlike the per-vaccine columns) and no zero-dimmed variant (a day with
// 0 total is still a real "nothing scheduled" total; heatmapCellBackground
// already renders 0 as plain white on its own, same as everywhere else).
// `base` is whichever row's own Total-cell style (styles.totalCell for a
// daily-breakdown row, styles.sumRowCell for the Today summary row) so
// this only ever changes the background, nothing else about that row.
export function totalCellStyle(base: typeof styles.totalCell | typeof styles.sumRowCell, background: string) {
  return { ...base, background };
}

// One <th> to render, with its col/row span — see buildHeaderRows.
// `group` drives GROUP_COLORS above; every header cell belongs to
// exactly one of the 4 groups (ROUND 4 — AppointmentTableColumn.group is
// no longer nullable).
export type HeaderCell = {
  key: string;
  label: string;
  colSpan: number;
  rowSpan: number;
  group: AppointmentTableColumn["group"];
};

/**
 * Turns AppointmentTable.columns into the 3 header <tr>s the compact
 * chart-style table needs (V-T-schedule-table ROUND 2, Will 2026-09-05:
 * "make a heading above it, then subsection. Ex: Flu > 3-64, 65+, Unk,
 * COVID > Mod > 3-11, 12-64, 65+"; ROUND 4 regroups the plain columns
 * into "Common"/"Other" but the header SHAPE is unchanged — every column
 * now belongs to one of 4 groups instead of 2 groups + ungrouped):
 *   - row1: one spanning cell per contiguous group run (COVID, Flu,
 *     Common, or Other), colSpan = the run's width, rowSpan 1.
  *   - row2: COVID's brand cells ("Pfizer"/"Moderna", each spanning its own
 *     age sub-run); every OTHER group's (Flu/Common/Other) leaf cells,
 *     each with rowSpan=HEADER_ROW_COUNT-1=2 since only COVID has a
 *     brand level, so a non-COVID leaf cell must fill both remaining
 *     rows.
 *   - row3: COVID's leaf age cells only (every other group's columns
 *     already finished spanning by row2/row1).
 * Runs are contiguous stretches of `columns` sharing the same `group`
 * (and, within a COVID run, the same `subgroup`) — see
 * AppointmentTableColumn's doc comment in lib/appointment-table.ts.
 */
export function buildHeaderRows(columns: AppointmentTableColumn[]): {
  row1: HeaderCell[];
  row2: HeaderCell[];
  row3: HeaderCell[];
} {
  const row1: HeaderCell[] = [];
  const row2: HeaderCell[] = [];
  const row3: HeaderCell[] = [];

  let i = 0;
  while (i < columns.length) {
    const column = columns[i];

    let j = i;
    while (j < columns.length && columns[j].group === column.group) j += 1;
    const run = columns.slice(i, j);
    row1.push({ key: `group-${i}`, label: column.group, colSpan: run.length, rowSpan: 1, group: column.group });

    if (column.group === "COVID") {
      // Subdivide the run into contiguous sub-runs by brand (subgroup),
      // one thSub cell per brand, then one leaf age cell per column
      // underneath.
      let k = 0;
      while (k < run.length) {
        const brand = run[k].subgroup;
        let m = k;
        while (m < run.length && run[m].subgroup === brand) m += 1;
        const subRun = run.slice(k, m);
        row2.push({
          key: `subgroup-${i}-${k}`,
          label: brand ?? "",
          colSpan: subRun.length,
          rowSpan: 1,
          group: column.group,
        });
        for (const leaf of subRun) {
          row3.push({ key: leaf.vaccineName, label: leaf.label, colSpan: 1, rowSpan: 1, group: leaf.group });
        }
        k = m;
      }
    } else {
      // Flu / Common / Other: no sub-group level — one leaf cell per
      // column, spanning both remaining header rows.
      for (const leaf of run) {
        row2.push({
          key: leaf.vaccineName,
          label: leaf.label,
          colSpan: 1,
          rowSpan: HEADER_ROW_COUNT - 1,
          group: leaf.group,
        });
      }
    }

    i = j;
  }

  return { row1, row2, row3 };
}

// Dim, deterministic zero-cell rendering (V-T-schedule-table ROUND 2,
// Will: "Zero cells may render as a dim '0' ... your call") — keeps the
// literal digit (unambiguous vs. a placeholder glyph like "·") but greys
// it out so a skim lands on the nonzero cells first; that dim styling
// stays even under ROUND 6's heatmap (a zero cell's heatmap background is
// always plain white anyway — see heatmapCellBackground). `dailyScaleMax`
// is the day-by-day breakdown's own independent scale (V-T12) — every
// breakdown row uses this same max, never the Next-7/After-today one.
export function renderCount(column: AppointmentTableColumn, n: number, dailyScaleMax: number) {
  return (
    <td key={column.vaccineName} style={dataCellStyle(n === 0, heatmapCellBackground(n, dailyScaleMax))}>
      {n}
    </td>
  );
}

export function formatDayLabel(dateStr: string): string {
  // Parse as local, not UTC, so the weekday shown matches the date shown.
  // Abbreviated ("Mon 8/17" not "Mon, Aug 17") — part of the compact-table
  // pass (V-T-schedule-table, Will 2026-09-04).
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday} ${month}/${day}`;
}

/**
 * The shared <colgroup> + 3-row grouped <thead> for the pivoted schedule
 * table — used by the 7-day page and the date-range page.
 */
export function ScheduleTableHead({ columns }: { columns: AppointmentTableColumn[] }) {
  const headerRows = buildHeaderRows(columns);
  return (
    <>
      <colgroup>
        {/* Date column: no explicit width — sizes to its own content. */}
        <col />
        <col style={{ width: `${TOTAL_COL_WIDTH_PX}px` }} />
        {columns.map((column) => (
          <col key={column.vaccineName} style={{ width: `${DATA_COL_WIDTH_PX}px` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th style={styles.thType} rowSpan={HEADER_ROW_COUNT}>
            Scheduled date
          </th>
          <th style={styles.thLeaf} rowSpan={HEADER_ROW_COUNT}>
            Total
          </th>
          {headerRows.row1.map((cell) => (
            <th key={cell.key} style={groupHeaderStyle(cell.group)} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
              {cell.label}
            </th>
          ))}
        </tr>
        <tr>
          {headerRows.row2.map((cell) =>
            cell.rowSpan === HEADER_ROW_COUNT - 1 ? (
              <th key={cell.key} style={leafHeaderStyle(cell.group)} rowSpan={cell.rowSpan}>
                {cell.label}
              </th>
            ) : (
              <th key={cell.key} style={subHeaderStyle(cell.group)} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>
                {cell.label}
              </th>
            )
          )}
        </tr>
        <tr>
          {headerRows.row3.map((cell) => (
            <th key={cell.key} style={leafHeaderStyle(cell.group)} rowSpan={cell.rowSpan}>
              {cell.label}
            </th>
          ))}
        </tr>
      </thead>
    </>
  );
}

/**
 * Point-of-care tests section (heading + table, or a muted one-liner when no
 * test-type columns exist in the range) — shared by the 7-day page and the
 * date-range page. Moved verbatim from app/appointments/page.tsx; see
 * lib/poc-test-table.ts for the table builder.
 */
export function PocTestsSection({ testTable }: { testTable: PocTestTable }) {
  const testHeatmapMaxes = computePocTestHeatmapMaxes(testTable);
  return (
    <>
      <h2 style={styles.hourlyHeading}>Point-of-care tests</h2>
      {isPocTestTableEmpty(testTable) ? (
        <p style={styles.muted}>No point-of-care tests scheduled in this range.</p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <colgroup>
              <col />
              <col style={{ width: `${TOTAL_COL_WIDTH_PX}px` }} />
              {testTable.columns.map((column) => (
                <col key={column.testName} style={{ width: `${DATA_COL_WIDTH_PX}px` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th style={styles.thType}>Scheduled date</th>
                <th style={styles.thLeaf}>Total</th>
                {testTable.columns.map((column) => (
                  <th key={column.testName} style={{ ...styles.thLeaf, ...COLUMN_DIVIDER }}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {testTable.days.map((day) => (
                <tr key={day}>
                  <td style={styles.tdType}>{formatDayLabel(day)}</td>
                  <td
                    style={totalCellStyle(
                      styles.totalCell,
                      heatmapCellBackground(testTable.dailyTotals[day], testHeatmapMaxes.totalScaleMax)
                    )}
                  >
                    {testTable.dailyTotals[day]}
                  </td>
                  {testTable.columns.map((column, index) =>
                    renderCount(
                      { vaccineName: column.testName, group: "Other", subgroup: null, label: column.label },
                      testTable.rows[index].countsByDay[day],
                      testHeatmapMaxes.dataScaleMax
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
