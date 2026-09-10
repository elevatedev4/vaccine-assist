"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { todayInChicago } from "@/lib/chicago-date";
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
  formatHourLabel,
  groupedRowsToCsv,
  groupRows,
  rowsToCsv,
  sortRows,
  vaccineCellValues,
  type ExplorerFilters,
  type ExplorerRow,
  type ExplorerRowGroup,
  type FilterChip,
  type GroupByMode,
  type SortDirection,
  type SortKey,
} from "@/lib/appointment-explorer";

/**
 * Data Explorer (V-data-explorer, Will 2026-09-08 verbatim: "a data
 * explorer page for me to see all the data and search and filter and
 * perform sum functions on it"). One row per appointment, de-identified —
 * fetched via app/api/acuity/poll/route.ts's `?rows=1` mode, which is the
 * ONLY source of appointment data this page ever reads; see
 * lib/appointment-explorer.ts for every filter/sort/sum/group/CSV
 * function (kept pure + unit-tested there rather than inline here).
 */

// The poll route caps a single `?rows=1` request at this many days
// (MAX_RANGE_DAYS in route.ts) — kept as its own constant here (rather
// than imported, since that route file isn't a client-safe module) so a
// wider caller-selected range can be paged into sequential requests via
// chunkDateRange. Mirror the route's own value if it ever changes.
const MAX_RANGE_DAYS_PER_REQUEST = 31;

// Default range (V-T28, Will 2026-09-09 verbatim: "Make data explorer
// default to today as the starting point and go forward 3 months.") —
// supersedes the original 28-days-back/91-days-forward default. Range
// basis (rangeBasis state below, unchanged by this) still governs which
// date field the already-loaded rows are re-filtered against; this only
// changes the initial fetch window/draft inputs.
const DEFAULT_LOOKAHEAD_MONTHS = 3;

// Renders up to this many (already filtered+sorted) rows before a "Show
// more" button reveals the next batch — keeps a large range from
// rendering thousands of <tr>s at once.
const PAGE_SIZE = 500;

const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type RangeBasis = "appointment" | "booking";

function defaultRangeDates(): { start: string; end: string } {
  const today = todayInChicago();
  return {
    start: today,
    end: addMonthsToDate(today, DEFAULT_LOOKAHEAD_MONTHS),
  };
}

const styles = {
  mainWide: { fontFamily: "system-ui, sans-serif", padding: "1rem 1.5rem", fontSize: "0.72rem" },
  heading: { margin: "0.5rem 0 0.5rem", fontSize: "1.25rem" },
  backLink: { fontSize: "0.8rem", margin: "0 0 0.75rem" },
  controlsRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "flex-end",
    gap: "0.9rem",
    margin: "0 0 0.75rem",
  },
  controlGroup: { display: "flex", flexDirection: "column" as const, gap: "0.2rem" },
  label: { fontWeight: 600, fontSize: "0.68rem", color: "#333" },
  input: { padding: "0.3rem 0.4rem", fontSize: "0.72rem", border: "1px solid #ccc", borderRadius: 3 },
  searchInput: { padding: "0.3rem 0.4rem", fontSize: "0.72rem", border: "1px solid #ccc", borderRadius: 3, width: "16rem" },
  button: { padding: "0.35rem 0.8rem", fontSize: "0.72rem", cursor: "pointer" },
  toggleRow: { display: "flex", gap: "0.3rem" },
  toggleButton: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #999",
    background: "#fff",
    cursor: "pointer",
    borderRadius: 4,
  },
  toggleButtonActive: {
    padding: "0.3rem 0.6rem",
    fontSize: "0.7rem",
    border: "1px solid #1e6b3a",
    background: "#16a34a",
    color: "#fff",
    cursor: "pointer",
    borderRadius: 4,
    fontWeight: 600,
  },
  error: { color: "#b00020" },
  warning: { color: "#8a5300", background: "#fff4e0", padding: "0.5rem 0.75rem", borderRadius: 4 },
  muted: { color: "#555", fontSize: "0.72rem" },
  // V-T-explorer-loading (Will, round-4 verbatim: "make sure a spinning
  // loader or something shows when the query is being run but hasn't
  // responded yet. Right now it just looks like a big delay."):
  // `resultsAreaWrap` wraps everything below the controls row so the
  // overlay below can sit on top of it (position: relative anchor);
  // `loadingOverlay` is the actual spinner + "Loading…" banner, shown the
  // instant `loading` goes true (see loadRows in the component below) —
  // BEFORE any fetch response, not after — and the previous table stays
  // visible underneath at reduced opacity (see the inline opacity style
  // where this is used) rather than being unmounted, so a filter/sort
  // click during a fetch doesn't flash to a blank page.
  resultsAreaWrap: { position: "relative" as const },
  loadingOverlay: {
    position: "absolute" as const,
    inset: 0,
    zIndex: 20,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    paddingTop: "3rem",
    background: "rgba(255,255,255,0.72)",
  },
  spinner: {
    width: "1.6rem",
    height: "1.6rem",
    borderRadius: "50%",
    border: "3px solid #d5dce3",
    borderTopColor: "#16a34a",
    animation: "explorer-spin 0.7s linear infinite",
  },
  loadingLabel: { fontSize: "0.78rem", fontWeight: 600, color: "#333" },
  sumsPanel: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "1.5rem",
    alignItems: "flex-end",
    padding: "0.6rem 0.8rem",
    margin: "0 0 0.75rem",
    background: "#f4f6f8",
    border: "1px solid #e2e5e9",
    borderRadius: 6,
  },
  sumStat: { display: "flex", flexDirection: "column" as const },
  sumStatLabel: { fontSize: "0.62rem", color: "#666", textTransform: "uppercase" as const, letterSpacing: "0.03em" },
  sumStatValue: { fontSize: "1.1rem", fontWeight: 700 },
  // V-T27 rebuild (Will, verbatim 2026-09-09: "Group by should make groups
  // and display the data in a table under each group. The current
  // functionality is summing."): one of these per group value — a heading
  // ("<group> — N appointments") followed by that group's own full rows
  // table (renderRowsTable, which reuses styles.tableWrap below), stacked
  // top to bottom.
  groupSection: { marginTop: "1.1rem" },
  groupHeading: { fontSize: "0.85rem", fontWeight: 700, margin: "0 0 0.35rem" },
  // Explorer table overflow fix (Will, 2026-09-08 follow-up): the table
  // wrapper below is the ONLY element allowed to scroll horizontally — the
  // page body itself must never scroll sideways. `maxWidth: "100%"`
  // (rather than relying on the block-level default alone) keeps this div
  // from ever growing past its parent <main> even if some ancestor's own
  // box model gets adjusted later.
  tableWrap: { overflowX: "auto" as const, maxWidth: "100%" },
  table: { borderCollapse: "collapse" as const, fontSize: "0.72rem", width: "100%" },
  th: {
    textAlign: "left" as const,
    padding: "0.2rem 0.4rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    userSelect: "none" as const,
  },
  thLabel: { display: "inline-flex", alignItems: "center", gap: "0.25rem" },
  td: { padding: "0.15rem 0.4rem", borderBottom: "1px solid #eee", whiteSpace: "nowrap" as const },
  // Vaccines/Tests and Appointment type cells can carry long joined lists
  // that otherwise blow the table out to many thousands of pixels wide and
  // clip later columns (Will, 2026-09-08 follow-up: "# vaccines column is
  // clipped") — capped width + normal wrapping keeps a long value wrapping
  // onto multiple lines within its own cell instead of forcing the whole
  // table wider.
  tdVaccines: {
    padding: "0.15rem 0.4rem",
    borderBottom: "1px solid #eee",
    whiteSpace: "normal" as const,
    maxWidth: "520px",
  },
  tdAppointmentType: {
    padding: "0.15rem 0.4rem",
    borderBottom: "1px solid #eee",
    whiteSpace: "normal" as const,
    maxWidth: "260px",
  },

  // V-T24 rebuild (Will, verbatim: "The filtering option needs to be more
  // refined, it's very clunky right now and I don't see a way to clear
  // the filters"): a small "⌄" icon after each column's header label
  // opens a popover for that column's filter — filled/tinted when the
  // column has an active filter, plain/muted otherwise, so a skim across
  // the header row shows exactly which columns are currently filtered.
  filterIconButton: {
    border: "none",
    background: "none",
    padding: "0 0.1rem",
    fontSize: "0.7rem",
    cursor: "pointer",
    color: "#888",
    lineHeight: 1,
  },
  filterIconButtonActive: {
    border: "none",
    background: "#16a34a",
    color: "#fff",
    borderRadius: 3,
    padding: "0 0.2rem",
    fontSize: "0.7rem",
    cursor: "pointer",
    lineHeight: 1.3,
  },

  // Active-filter chip row, above the table (Will: one chip per active
  // filter, e.g. "Day: Mon, Tue ✕", plus a "Clear all filters" button).
  chipRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: "0.4rem",
    margin: "0 0 0.6rem",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3rem",
    background: "#eef2f6",
    border: "1px solid #d5dce3",
    borderRadius: 999,
    padding: "0.15rem 0.4rem 0.15rem 0.6rem",
    fontSize: "0.68rem",
    color: "#333",
  },
  chipRemoveButton: {
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: "0.68rem",
    color: "#666",
    padding: "0 0.15rem",
    lineHeight: 1,
  },
  clearAllButton: {
    border: "1px solid #b00020",
    background: "#fff",
    color: "#b00020",
    borderRadius: 4,
    padding: "0.15rem 0.5rem",
    fontSize: "0.68rem",
    cursor: "pointer",
  },

  // Popover chrome — rendered via a portal into document.body (position:
  // fixed, anchored to the trigger icon's own bounding rect) so it's never
  // clipped by the table's own overflow-x: auto scroll wrapper. The
  // backdrop is a full-viewport transparent layer that closes the popover
  // on any outside click, same "click outside/Esc closes" contract as a
  // native <dialog> without needing one.
  popoverBackdrop: { position: "fixed" as const, inset: 0, zIndex: 40 },
  popover: {
    position: "fixed" as const,
    zIndex: 41,
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
    padding: "0.5rem",
    minWidth: "11rem",
    maxWidth: "16rem",
    fontSize: "0.72rem",
  },
  popoverInput: {
    width: "100%",
    boxSizing: "border-box" as const,
    fontSize: "0.72rem",
    padding: "0.25rem 0.35rem",
    border: "1px solid #ccc",
    borderRadius: 3,
    marginBottom: "0.35rem",
  },
  popoverActions: {
    display: "flex",
    gap: "0.6rem",
    margin: "0 0 0.35rem",
  },
  popoverLinkButton: {
    border: "none",
    background: "none",
    padding: 0,
    fontSize: "0.68rem",
    color: "#1a5fb4",
    textDecoration: "underline",
    cursor: "pointer",
  },
  popoverChecklist: {
    maxHeight: "12rem",
    overflowY: "auto" as const,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.15rem",
  },
  popoverCheckboxRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.35rem",
    fontSize: "0.7rem",
    cursor: "pointer",
  },
} as const;

// Same group tints as app/appointments/page.tsx's GROUP_COLORS — applied
// here only to the header cells that are actually vaccine-group-specific
// (COVID brand/age, Flu age); the other columns (dates, type, vaccine
// list, counts) aren't a single vaccine group, so they stay neutral.
const GROUP_HEADER_COLORS = { covid: "#dbe7f9", flu: "#f9e2cc" } as const;

const COLUMN_DIVIDER = { borderLeft: "1px solid #c9c9c9" } as const;

type ColumnDef = {
  key: SortKey;
  label: string;
  headerBackground?: string;
};

const COLUMNS: ColumnDef[] = [
  { key: "date", label: "Appt date" },
  { key: "day", label: "Day" },
  { key: "hour", label: "Hour" },
  { key: "createdDate", label: "Booked on" },
  { key: "leadDays", label: "Lead days" },
  { key: "appointmentTypeName", label: "Appointment type" },
  { key: "vaccineNames", label: "Vaccines" },
  { key: "testNames", label: "Tests" },
  { key: "vaccineCount", label: "# vaccines" },
  { key: "covidBrand", label: "COVID brand", headerBackground: GROUP_HEADER_COLORS.covid },
  { key: "covidAgeBucket", label: "COVID age", headerBackground: GROUP_HEADER_COLORS.covid },
  { key: "fluAgeBucket", label: "Flu age", headerBackground: GROUP_HEADER_COLORS.flu },
];

const GROUP_BY_OPTIONS: Array<{ value: GroupByMode; label: string }> = [
  { value: "none", label: "None" },
  { value: "apptDate", label: "Appointment date" },
  { value: "bookedOn", label: "Booking date" },
  { value: "day", label: "Day of week" },
  { value: "hour", label: "Hour" },
  { value: "vaccine", label: "Vaccine" },
  { value: "test", label: "Test" },
  { value: "appointmentType", label: "Appointment type" },
  { value: "covidBrand", label: "COVID brand" },
  { value: "covidAge", label: "COVID age" },
  { value: "fluAge", label: "Flu age" },
];

// V-T24 rebuild: which SortKey columns are text-filtered vs.
// checklist-filtered, and which ExplorerFilters field each one reads/
// writes — drives both the header's filter icon (openFilterFor) and which
// popover body renders. Columns with no entry here (currently none — every
// COLUMNS entry has a filter) would simply render no filter icon.
type TextFilterField = "apptDateText" | "bookedOnText" | "leadDaysText" | "vaccineCountText";
type ChecklistFilterField =
  | "day"
  | "hour"
  | "appointmentType"
  | "vaccine"
  | "tests"
  | "covidBrand"
  | "covidAge"
  | "fluAge";

type ColumnFilterKind = { kind: "text"; field: TextFilterField } | { kind: "checklist"; field: ChecklistFilterField };

const FILTER_KIND_BY_COLUMN: Partial<Record<SortKey, ColumnFilterKind>> = {
  date: { kind: "text", field: "apptDateText" },
  day: { kind: "checklist", field: "day" },
  hour: { kind: "checklist", field: "hour" },
  createdDate: { kind: "text", field: "bookedOnText" },
  leadDays: { kind: "text", field: "leadDaysText" },
  appointmentTypeName: { kind: "checklist", field: "appointmentType" },
  vaccineNames: { kind: "checklist", field: "vaccine" },
  testNames: { kind: "checklist", field: "tests" },
  vaccineCount: { kind: "text", field: "vaccineCountText" },
  covidBrand: { kind: "checklist", field: "covidBrand" },
  covidAgeBucket: { kind: "checklist", field: "covidAge" },
  fluAgeBucket: { kind: "checklist", field: "fluAge" },
};

/** Is THIS column's own filter currently active — drives the filled vs.
 * plain filter icon in the header (Will: "Header shows a filled icon when
 * that column has an active filter"). */
function isColumnFilterActive(filters: ExplorerFilters, kind: ColumnFilterKind): boolean {
  return kind.kind === "text" ? filters[kind.field].trim().length > 0 : filters[kind.field].length > 0;
}

/** Anchor + which column's popover is open — at most one popover open at
 * a time (opening a second closes the first, same as a native dropdown). */
type OpenFilterState = { key: SortKey; rect: DOMRect };

/** Esc closes the currently-open popover (Will: "Keyboard: Esc closes
 * popover") — a single document-level listener, active only while a
 * popover is actually open. */
function useCloseFilterOnEscape(isOpen: boolean, onClose: () => void) {
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);
}

/**
 * Shared popover chrome — rendered via createPortal into document.body so
 * it's never clipped by the table's own `overflow-x: auto` wrapper (a
 * popover positioned relative to a header cell INSIDE that wrapper would
 * get cut off for any column near the right edge once the table scrolls
 * horizontally). `anchorRect` is the trigger button's own
 * getBoundingClientRect(), captured once at open time — position: fixed
 * against that rect, not re-measured on scroll (acceptable simplification
 * for a prototype: closing on any outside click/scroll-then-click already
 * covers the common case). The backdrop is a full-viewport transparent
 * layer whose own click closes the popover (Will: "click outside/Esc
 * closes").
 */
function FilterPopover({
  anchorRect,
  onClose,
  children,
}: {
  anchorRect: DOMRect;
  onClose: () => void;
  children: ReactNode;
}) {
  useCloseFilterOnEscape(true, onClose);

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      <div style={styles.popoverBackdrop} onClick={onClose} />
      <div
        style={{ ...styles.popover, top: anchorRect.bottom + 4, left: Math.max(4, anchorRect.left) }}
        // Stop a click INSIDE the popover from bubbling to the backdrop
        // (which would otherwise close it on every checkbox/text click).
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

/** Text-column filter popover body — a single input plus a "Clear" link
 * (Will: "for text columns a single input with an ✕" — the ✕ lives on
 * the header's own filled icon / the chip row; this "Clear" link is the
 * same action from inside the popover, for a column with no chip yet
 * because it's the very first keystroke). */
function TextFilterPopoverBody({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}) {
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opening this
          popover IS the user asking to type into it. */}
      <input
        autoFocus
        type="text"
        style={styles.popoverInput}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div style={styles.popoverActions}>
        <button type="button" style={styles.popoverLinkButton} onClick={() => onChange("")}>
          Clear
        </button>
        <button type="button" style={styles.popoverLinkButton} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Enumerated-column filter popover body — a search-within-options box, an
 * "All"/"None" link pair, and a checklist (Will: "for enumerated columns a
 * checklist with a search box, 'All' / 'None' links"). */
function ChecklistFilterPopoverBody({
  options,
  selected,
  onChange,
  onClose,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const filteredOptions = options.filter((option) => option.toLowerCase().includes(search.trim().toLowerCase()));

  function toggle(option: string, checked: boolean) {
    onChange(checked ? [...selected, option] : selected.filter((value) => value !== option));
  }

  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus -- see TextFilterPopoverBody. */}
      <input
        autoFocus
        type="text"
        placeholder="Search…"
        style={styles.popoverInput}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div style={styles.popoverActions}>
        <button type="button" style={styles.popoverLinkButton} onClick={() => onChange(options)}>
          All
        </button>
        <button type="button" style={styles.popoverLinkButton} onClick={() => onChange([])}>
          None
        </button>
        <button type="button" style={styles.popoverLinkButton} onClick={onClose}>
          Done
        </button>
      </div>
      <div style={styles.popoverChecklist}>
        {filteredOptions.length === 0 && <span style={styles.muted}>No matches</span>}
        {filteredOptions.map((option) => (
          <label key={option} style={styles.popoverCheckboxRow}>
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={(event) => toggle(option, event.target.checked)}
            />
            {option}
          </label>
        ))}
      </div>
    </div>
  );
}

function formatAsOf(asOf: string | null): string {
  if (!asOf) return "";
  return new Date(asOf).toLocaleString();
}

function avgOrDash(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

export default function AppointmentExplorerPage() {
  // Same shared-pharmacy-login session pattern as app/appointments/page.tsx.
  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  // Draft range inputs (what the user is typing) vs. applied range (what
  // was actually last fetched) — "Apply" copies draft -> applied, which
  // is what triggers the fetch effect below.
  const [draftStart, setDraftStart] = useState(() => defaultRangeDates().start);
  const [draftEnd, setDraftEnd] = useState(() => defaultRangeDates().end);
  const [appliedStart, setAppliedStart] = useState(() => defaultRangeDates().start);
  const [appliedEnd, setAppliedEnd] = useState(() => defaultRangeDates().end);

  // "Appointment date | Booking date" — JUDGMENT CALL: Acuity's
  // appointments endpoint only supports querying by APPOINTMENT date
  // (minDate/maxDate — see lib/acuity-client.ts), so the fetch itself
  // always uses [appliedStart, appliedEnd] as an appointment-date range.
  // This toggle instead re-filters the already-fetched rows by whichever
  // field the caller wants compared against that same range (`date` vs
  // `createdDate`) — see basisFilteredRows below. A "Booking date" range
  // therefore only surfaces bookings made in-range for an appointment
  // that ALSO falls in the fetched appointment-date window; there's no
  // Acuity API to query bookings by created-date directly (see
  // lib/acuity-booking-activity.ts for how the main dashboard's own
  // booking-activity table works around the same limitation, at a fixed
  // ~134-day lookback rather than an arbitrary caller range).
  const [rangeBasis, setRangeBasis] = useState<RangeBasis>("appointment");

  const [rows, setRows] = useState<ExplorerRow[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filters, setFilters] = useState<ExplorerFilters>(() => clearAllFilters());
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [groupBy, setGroupBy] = useState<GroupByMode>("none");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // V-T24 rebuild: at most one column filter popover open at a time — see
  // OpenFilterState/FilterPopover above.
  const [openFilter, setOpenFilter] = useState<OpenFilterState | null>(null);
  const closeFilterPopover = useCallback(() => setOpenFilter(null), []);

  // V-T-explorer-loading round 4 (Will, verbatim: "make sure a spinning
  // loader ... shows when the query is being run but hasn't responded
  // yet"): a monotonically-increasing request id, bumped at the START of
  // every loadRows call (Apply/Refresh/initial fetch/a paged chunk run)
  // and re-checked before that call is allowed to touch state — guards
  // against an OUT-OF-ORDER response (e.g. Refresh clicked twice, or Apply
  // clicked again before the first range's fetch finished) overwriting a
  // newer request's already-landed result with a stale one. Not React
  // state on purpose — bumping it must never itself trigger a re-render.
  const loadRequestIdRef = useRef(0);

  function resetAfterSignOut() {
    // Bump the request id too — an in-flight request from before sign-out
    // must not be allowed to repopulate `rows` after this reset.
    loadRequestIdRef.current += 1;
    setRows([]);
    setConfigured(null);
    setAsOf(null);
    setLoadError(null);
    setFilters(clearAllFilters());
    setVisibleCount(PAGE_SIZE);
    setOpenFilter(null);
  }

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
        if (!state) resetAfterSignOut();
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Fetches rows for [start, end] — sequential per-chunk requests (never
  // parallel) via lib/appointment-explorer.ts's chunkDateRange whenever
  // the requested span exceeds MAX_RANGE_DAYS_PER_REQUEST, since the poll
  // route enforces that cap per request. `configured` is read off only
  // the FIRST chunk's response — Acuity being configured or not can't
  // differ between chunks of the same request.
  const loadRows = useCallback(async (token: string, start: string, end: string, options?: { force?: boolean }) => {
    // See loadRequestIdRef's own doc comment above — this request "owns"
    // requestId for its whole lifetime; every state write below (and the
    // final setLoading(false)) is gated on still being the CURRENT
    // request, so a slower, now-superseded fetch can never clobber a
    // faster, newer one's result (or its loading indicator).
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const chunks = chunkDateRange(start, end, MAX_RANGE_DAYS_PER_REQUEST);
      const forceParam = options?.force ? "&force=1" : "";
      const collected: ExplorerRow[] = [];
      let latestAsOf: string | null = null;
      let sawConfigured = true;

      for (const chunk of chunks) {
        const response = await fetch(`/api/acuity/poll?rows=1&start=${chunk.start}&end=${chunk.end}${forceParam}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (loadRequestIdRef.current !== requestId) return; // superseded mid-chunk
        const data = await response.json();
        if (loadRequestIdRef.current !== requestId) return; // superseded while awaiting .json()
        if (!response.ok) {
          setLoadError(data.error ?? "Could not load appointment data.");
          return;
        }
        if (!data.configured) {
          sawConfigured = false;
          break;
        }
        collected.push(...(data.rows as ExplorerRow[]));
        latestAsOf = data.asOf;
      }

      if (loadRequestIdRef.current !== requestId) return; // superseded before the last chunk landed
      setConfigured(sawConfigured);
      setRows(collected);
      setAsOf(latestAsOf);
      setVisibleCount(PAGE_SIZE);
    } catch (err) {
      if (loadRequestIdRef.current !== requestId) return;
      setLoadError(err instanceof Error ? err.message : "Could not load appointment data.");
    } finally {
      // Only the current request is allowed to clear the spinner — an
      // old, superseded request finishing late must not turn off loading
      // while a newer request is still in flight.
      if (loadRequestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void loadRows(session.accessToken, appliedStart, appliedEnd);
  }, [session, appliedStart, appliedEnd, loadRows]);

  function handleApply() {
    setAppliedStart(draftStart);
    setAppliedEnd(draftEnd);
  }

  function handleRefresh() {
    if (session) void loadRows(session.accessToken, appliedStart, appliedEnd, { force: true });
  }

  async function handleSignIn(event: FormEvent) {
    event.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: signInEmail,
        password: signInPassword,
      });
      if (error || !data.session) {
        setSignInError(error?.message ?? "Sign-in failed.");
        return;
      }
      setSession(toSessionState(data.session));
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  }

  // See rangeBasis's own doc comment above for why this is a
  // post-fetch re-filter rather than a second fetch mode.
  const basisFilteredRows = useMemo(() => {
    if (rangeBasis === "appointment") return rows;
    return rows.filter((row) => row.createdDate >= appliedStart && row.createdDate <= appliedEnd);
  }, [rows, rangeBasis, appliedStart, appliedEnd]);

  // Distinct option lists for every multi-select column filter, derived
  // from the range-basis-filtered set (NOT the further column-filtered
  // set) so a dropdown's own options don't shrink away as other filters
  // narrow the result — same "options describe the loaded range, not the
  // current filter state" convention most data-grid UIs use.
  const filterOptions = useMemo(() => {
    const days = new Set<string>();
    const hourToValue = new Map<string, number>();
    const types = new Set<string>();
    const vaccines = new Set<string>();
    const tests = new Set<string>();
    const covidBrands = new Set<string>();
    const covidAges = new Set<string>();
    const fluAges = new Set<string>();

    for (const row of basisFilteredRows) {
      days.add(dayOfWeekLabel(row.date));
      hourToValue.set(formatHourLabel(row.hourOfDay), row.hourOfDay);
      types.add(row.appointmentTypeName);
      for (const name of row.vaccineNames) vaccines.add(name);
      for (const name of row.testNames) tests.add(name);
      covidBrands.add(row.covidBrand);
      covidAges.add(row.covidAgeBucket);
      fluAges.add(row.fluAgeBucket);
    }

    return {
      day: Array.from(days).sort((a, b) => DAY_ORDER.indexOf(a as (typeof DAY_ORDER)[number]) - DAY_ORDER.indexOf(b as (typeof DAY_ORDER)[number])),
      hour: Array.from(hourToValue.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([label]) => label),
      appointmentType: Array.from(types).sort(),
      vaccine: Array.from(vaccines).sort(),
      tests: Array.from(tests).sort(),
      covidBrand: Array.from(covidBrands).sort(),
      covidAge: Array.from(covidAges).sort(),
      fluAge: Array.from(fluAges).sort(),
    };
  }, [basisFilteredRows]);

  const filteredRows = useMemo(() => applyFilters(basisFilteredRows, filters), [basisFilteredRows, filters]);
  const sortedRows = useMemo(() => sortRows(filteredRows, sortKey, sortDirection), [filteredRows, sortKey, sortDirection]);
  const sums = useMemo(() => computeSums(filteredRows), [filteredRows]);
  const visibleRows = sortedRows.slice(0, visibleCount);

  // V-T27 rebuild (Will, verbatim: "Group by should make groups and
  // display the data in a table under each group. The current
  // functionality is summing."): group the FILTERED (not yet sorted) rows
  // into their "sensible order" buckets (see groupRows's own doc comment
  // for what that means per mode), then sort each group's own row list
  // with the SAME sortKey/sortDirection the flat table uses — a grouped
  // table is never out of sync with the ungrouped one's own sort. Not
  // sliced to PAGE_SIZE/visibleCount: unlike the single flat table, a
  // grouped view's rows are already split across multiple, typically much
  // smaller tables, so the "thousands of <tr>s in one table" problem
  // visibleCount exists for doesn't apply the same way here (JUDGMENT
  // CALL — no per-group "Show more" in this round).
  const groupedTables: ExplorerRowGroup[] = useMemo(() => {
    if (groupBy === "none") return [];
    return groupRows(filteredRows, groupBy).map((g) => ({ group: g.group, rows: sortRows(g.rows, sortKey, sortDirection) }));
  }, [filteredRows, groupBy, sortKey, sortDirection]);

  // V-T24 rebuild: the active-filter chip row above the table.
  const filterChips: FilterChip[] = useMemo(() => activeFilterChips(filters), [filters]);

  function handleClearAllFilters() {
    setFilters(clearAllFilters());
    setOpenFilter(null);
  }

  function handleHeaderClick(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  }

  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortDirection === "asc" ? " ▲" : " ▼";
  }

  // V-T27 rebuild: the header row is now shared by the single flat table
  // ("None" group-by) AND every per-group table — same columns, same
  // click-to-sort/filter-icon behavior in every case, since sort/filter
  // state (sortKey/sortDirection/filters/openFilter) all live above the
  // group-by split and apply identically to every group.
  function renderColumnHeaderRow() {
    return (
      <tr>
        {COLUMNS.map((column) => {
          const filterKind = FILTER_KIND_BY_COLUMN[column.key];
          const isActive = filterKind ? isColumnFilterActive(filters, filterKind) : false;
          return (
            <th
              key={column.key}
              style={{
                ...styles.th,
                ...COLUMN_DIVIDER,
                ...(column.headerBackground ? { background: column.headerBackground } : {}),
              }}
            >
              <span style={styles.thLabel}>
                <span onClick={() => handleHeaderClick(column.key)}>
                  {column.label}
                  {sortIndicator(column.key)}
                </span>
                {filterKind && (
                  <button
                    type="button"
                    style={isActive ? styles.filterIconButtonActive : styles.filterIconButton}
                    aria-label={`Filter ${column.label}`}
                    aria-pressed={isActive}
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setOpenFilter((current) => (current?.key === column.key ? null : { key: column.key, rect }));
                    }}
                  >
                    ⌄
                  </button>
                )}
              </span>
            </th>
          );
        })}
      </tr>
    );
  }

  function renderDataRow(row: ExplorerRow, key: string) {
    const leadDaysValue = computeLeadDays(row);
    const leadDays = leadDaysValue === null ? "—" : String(leadDaysValue);
    // Vaccine-related cells (Vaccines/COVID brand/COVID age/Flu age) all
    // go through one shared decision (Will, verbatim: "On tests, vaccine
    // related fields should be blank, not have unknown or any written in
    // there") — see vaccineCellValues's own doc comment for the
    // test-only-vs-mixed-appointment rule. Every group-by table renders
    // through this SAME renderDataRow, so a grouped "Test" table's blanks
    // stay consistent with the flat table's automatically.
    const vaccineCells = vaccineCellValues(row);
    return (
      <tr key={key}>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.date}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{dayOfWeekLabel(row.date)}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{formatHourLabel(row.hourOfDay)}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.createdDate || "—"}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{leadDays}</td>
        <td style={{ ...styles.tdAppointmentType, ...COLUMN_DIVIDER }}>{row.appointmentTypeName}</td>
        <td style={{ ...styles.tdVaccines, ...COLUMN_DIVIDER }}>{vaccineCells.vaccineNamesDisplay}</td>
        <td style={{ ...styles.tdVaccines, ...COLUMN_DIVIDER }}>{row.testNames.join(", ") || "—"}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.vaccineNames.length}</td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.covid }}>
          {vaccineCells.covidBrand}
        </td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.covid }}>
          {vaccineCells.covidAgeBucket}
        </td>
        <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.flu }}>
          {vaccineCells.fluAgeBucket}
        </td>
      </tr>
    );
  }

  /** Same full rows table (same columns, sort, filters) rendered inside
   * its own horizontal-scroll wrapper — used for the flat "None" table AND
   * for every per-group table (V-T27: "the SAME full rows table"). `keyPrefix`
   * keeps row keys unique per table when the same appointment legitimately
   * renders in more than one group's table (the vaccine/test double-
   * membership modes) — React only needs uniqueness WITHIN one table's own
   * sibling list, but a shared prefix keeps that obviously true rather than
   * relying on it by accident. */
  function renderRowsTable(rows: ExplorerRow[], keyPrefix: string) {
    return (
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>{renderColumnHeaderRow()}</thead>
          <tbody>
            {rows.map((row, index) =>
              renderDataRow(row, `${keyPrefix}-${row.date}-${row.hourOfDay}-${row.appointmentTypeId}-${index}`)
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function handleDownloadCsv() {
    // V-T27: grouped mode exports with a leading "Group" column (same
    // group/row membership as the on-screen grouped tables); "None" stays
    // the original single-table export, unchanged.
    const csv = groupBy === "none" ? rowsToCsv(filteredRows) : groupedRowsToCsv(groupedTables);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `appointments_${appliedStart}_${appliedEnd}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to explore appointment data."
        email={signInEmail}
        password={signInPassword}
        onEmailChange={setSignInEmail}
        onPasswordChange={setSignInPassword}
        onSubmit={handleSignIn}
        error={signInError}
        submitting={signingIn}
      />
    );
  }

  return (
    <main style={styles.mainWide}>
      {/* Spinner keyframes for styles.spinner above — a plain global
          <style> tag (no external animation library) since this is the
          only place on the page that needs one. */}
      <style>{"@keyframes explorer-spin { to { transform: rotate(360deg); } }"}</style>
      <h1 style={styles.heading}>Data explorer</h1>
      <p style={styles.backLink}>
        <a href="/appointments">← Back to Schedule</a>
      </p>

      <div style={styles.controlsRow}>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="explorer-start">
            Start
          </label>
          <input
            id="explorer-start"
            type="date"
            style={styles.input}
            value={draftStart}
            onChange={(event) => setDraftStart(event.target.value)}
          />
        </div>
        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="explorer-end">
            End
          </label>
          <input
            id="explorer-end"
            type="date"
            style={styles.input}
            value={draftEnd}
            onChange={(event) => setDraftEnd(event.target.value)}
          />
        </div>
        <button type="button" style={styles.button} onClick={handleApply}>
          Apply
        </button>

        <div style={styles.controlGroup}>
          <span style={styles.label}>Range basis</span>
          <div style={styles.toggleRow}>
            <button
              type="button"
              style={rangeBasis === "appointment" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setRangeBasis("appointment")}
              aria-pressed={rangeBasis === "appointment"}
            >
              Appointment date
            </button>
            <button
              type="button"
              style={rangeBasis === "booking" ? styles.toggleButtonActive : styles.toggleButton}
              onClick={() => setRangeBasis("booking")}
              aria-pressed={rangeBasis === "booking"}
            >
              Booking date
            </button>
          </div>
        </div>

        <div style={styles.controlGroup}>
          <label style={styles.label} htmlFor="explorer-search">
            Search
          </label>
          <input
            id="explorer-search"
            type="text"
            placeholder="vaccine, brand, age, type, date…"
            style={styles.searchInput}
            value={filters.search}
            onChange={(event) => setFilters((f) => ({ ...f, search: event.target.value }))}
          />
        </div>

        <button type="button" style={styles.button} onClick={handleRefresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>

        <button type="button" style={styles.button} onClick={handleDownloadCsv} disabled={filteredRows.length === 0}>
          Download CSV
        </button>

        {asOf && <span style={styles.muted}>Data as of {formatAsOf(asOf)}</span>}
      </div>

      {loadError && <p style={styles.error}>{loadError}</p>}

      {/* V-T-explorer-loading round 4: the spinner overlay shows the
          INSTANT `loading` goes true (see loadRows — setLoading(true) runs
          before the fetch, not after) and sits above whatever was
          previously rendered here, regardless of `configured` — this
          fixes the original bug where the only "Loading…" text was gated
          behind `configured === true`, which stayed null for the entire
          initial fetch, so nothing at all showed while the first request
          was in flight. The content below stays mounted (just dimmed via
          opacity) rather than being replaced, so a date-range/filter/
          group-by change during a fetch never flashes to a blank page. */}
      <div style={styles.resultsAreaWrap}>
        {loading && (
          <div style={styles.loadingOverlay} role="status" aria-live="polite">
            <span style={styles.spinner} aria-hidden="true" />
            <span style={styles.loadingLabel}>Loading…</span>
          </div>
        )}
        <div style={{ opacity: loading ? 0.45 : 1, transition: "opacity 150ms ease" }}>
          {configured === false && (
            <p>
              Acuity credentials are not configured yet. <a href="/settings">Go to Settings</a>
            </p>
          )}

          {configured === true && !loading && rows.length === 0 && !loadError && (
            <p style={styles.muted}>No appointments found in this range.</p>
          )}

          {configured === true && (
            <>
              <div style={styles.sumsPanel}>
            <div style={styles.sumStat}>
              <span style={styles.sumStatLabel}>Appointments</span>
              <span style={styles.sumStatValue}>{sums.appointments}</span>
            </div>
            <div style={styles.sumStat}>
              <span style={styles.sumStatLabel}>Vaccines</span>
              <span style={styles.sumStatValue}>{sums.vaccines}</span>
            </div>
            <div style={styles.sumStat}>
              <span style={styles.sumStatLabel}>Avg vaccines/appt</span>
              <span style={styles.sumStatValue}>{avgOrDash(sums.avgVaccinesPerAppointment)}</span>
            </div>
            <div style={styles.sumStat}>
              <span style={styles.sumStatLabel}>Avg lead days</span>
              <span style={styles.sumStatValue}>{avgOrDash(sums.avgLeadDays)}</span>
            </div>
            <div style={styles.controlGroup}>
              <label style={styles.label} htmlFor="explorer-group-by">
                Group by
              </label>
              <select
                id="explorer-group-by"
                style={styles.input}
                value={groupBy}
                onChange={(event) => setGroupBy(event.target.value as GroupByMode)}
              >
                {GROUP_BY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* V-T24 rebuild (Will, verbatim: "The filtering option needs to
              be more refined, it's very clunky right now and I don't see a
              way to clear the filters"): the active-filter chip row lives
              ABOVE the table, one chip per active filter plus "Clear all
              filters" — see activeFilterChips/clearAllFilters/
              clearFilterKey in lib/appointment-explorer.ts. Only rendered
              when at least one filter (search included) is active. */}
          {filterChips.length > 0 && (
            <div style={styles.chipRow}>
              {filterChips.map((chip) => (
                <span key={chip.key} style={styles.chip}>
                  {chip.label}
                  <button
                    type="button"
                    style={styles.chipRemoveButton}
                    onClick={() => setFilters((f) => clearFilterKey(f, chip.key))}
                    aria-label={`Remove filter: ${chip.label}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button type="button" style={styles.clearAllButton} onClick={handleClearAllFilters}>
                Clear all filters
              </button>
            </div>
          )}

          {/* V-T27 rebuild (Will, verbatim: "Group by should make groups
              and display the data in a table under each group. The
              current functionality is summing."): "None" renders today's
              single flat table (with its own "Show more" paging); any
              other group-by renders one heading + full rows table PER
              group, in the group's own "sensible order" — see
              groupedTables/renderRowsTable above. */}
          {groupBy === "none" ? (
            <>
              {renderRowsTable(visibleRows, "flat")}

              {visibleCount < sortedRows.length && (
                <p>
                  <button
                    type="button"
                    style={styles.button}
                    onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                  >
                    Show more ({sortedRows.length - visibleCount} more)
                  </button>
                </p>
              )}
            </>
          ) : (
            groupedTables.map((groupTable) => (
              <div key={groupTable.group} style={styles.groupSection}>
                <h2 style={styles.groupHeading}>
                  {groupTable.group} — {groupTable.rows.length} appointment{groupTable.rows.length === 1 ? "" : "s"}
                </h2>
                {renderRowsTable(groupTable.rows, groupTable.group)}
              </div>
            ))
          )}

          {/* V-T24 rebuild: the one open column-filter popover, if any —
              see FilterPopover/FILTER_KIND_BY_COLUMN above. Rendered once,
              driven entirely by `openFilter` state; its own portal means
              physical placement in the tree doesn't matter. */}
          {openFilter &&
            (() => {
              const filterKind = FILTER_KIND_BY_COLUMN[openFilter.key];
              if (!filterKind) return null;
              const column = COLUMNS.find((c) => c.key === openFilter.key);

              return (
                <FilterPopover anchorRect={openFilter.rect} onClose={closeFilterPopover}>
                  {filterKind.kind === "text" ? (
                    <TextFilterPopoverBody
                      value={filters[filterKind.field]}
                      onChange={(next) => setFilters((f) => ({ ...f, [filterKind.field]: next }))}
                      onClose={closeFilterPopover}
                    />
                  ) : (
                    <ChecklistFilterPopoverBody
                      options={filterOptions[filterKind.field]}
                      selected={filters[filterKind.field]}
                      onChange={(next) => setFilters((f) => ({ ...f, [filterKind.field]: next }))}
                      onClose={closeFilterPopover}
                    />
                  )}
                  {column && (
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.62rem", color: "#888" }}>
                      Filtering: {column.label}
                    </p>
                  )}
                </FilterPopover>
              );
            })()}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
