"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { addDaysToChicagoDate, todayInChicago } from "@/lib/chicago-date";
import {
  applyFilters,
  chunkDateRange,
  computeGroups,
  computeLeadDays,
  computeSums,
  dayOfWeekLabel,
  EMPTY_EXPLORER_FILTERS,
  formatHourLabel,
  rowsToCsv,
  sortRows,
  type ExplorerFilters,
  type ExplorerRow,
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

// Default range (Will's spec, verbatim): "28 days back through 91 days
// forward."
const DEFAULT_LOOKBACK_DAYS = 28;
const DEFAULT_LOOKAHEAD_DAYS = 91;

// Renders up to this many (already filtered+sorted) rows before a "Show
// more" button reveals the next batch — keeps a large range from
// rendering thousands of <tr>s at once.
const PAGE_SIZE = 500;

const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type RangeBasis = "appointment" | "booking";

function defaultRangeDates(): { start: string; end: string } {
  const today = todayInChicago();
  return {
    start: addDaysToChicagoDate(today, -DEFAULT_LOOKBACK_DAYS),
    end: addDaysToChicagoDate(today, DEFAULT_LOOKAHEAD_DAYS),
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
  groupTableWrap: { marginTop: "0.6rem", overflowX: "auto" as const },
  tableWrap: { overflowX: "auto" as const },
  table: { borderCollapse: "collapse" as const, fontSize: "0.72rem", width: "100%" },
  th: {
    textAlign: "left" as const,
    padding: "0.2rem 0.4rem",
    borderBottom: "2px solid #ccc",
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    userSelect: "none" as const,
  },
  thFilterCell: { padding: "0.15rem 0.3rem", borderBottom: "2px solid #ccc", background: "#fafafa" },
  td: { padding: "0.15rem 0.4rem", borderBottom: "1px solid #eee", whiteSpace: "nowrap" as const },
  filterInput: { width: "100%", boxSizing: "border-box" as const, fontSize: "0.66rem", padding: "0.1rem 0.2rem" },
  filterSelect: {
    width: "100%",
    boxSizing: "border-box" as const,
    fontSize: "0.66rem",
    padding: "0.05rem",
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
  { value: "appointmentType", label: "Appointment type" },
  { value: "covidBrand", label: "COVID brand" },
  { value: "covidAge", label: "COVID age" },
  { value: "fluAge", label: "Flu age" },
];

/** Native multi-select dropdown — deliberately no new dependency (the
 * brief calls for "no new deps unless already in package.json"). Small
 * fixed size so it renders as a compact dropdown-ish list rather than a
 * tall box, regardless of how many options exist. */
function MultiSelectFilter({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <select
      multiple
      size={Math.min(4, Math.max(2, options.length))}
      style={styles.filterSelect}
      value={selected}
      onChange={(event) => {
        const next = Array.from(event.target.selectedOptions, (option) => option.value);
        onChange(next);
      }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
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

  const [filters, setFilters] = useState<ExplorerFilters>(EMPTY_EXPLORER_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [groupBy, setGroupBy] = useState<GroupByMode>("none");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  function resetAfterSignOut() {
    setRows([]);
    setConfigured(null);
    setAsOf(null);
    setLoadError(null);
    setFilters(EMPTY_EXPLORER_FILTERS);
    setVisibleCount(PAGE_SIZE);
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
        const data = await response.json();
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

      setConfigured(sawConfigured);
      setRows(collected);
      setAsOf(latestAsOf);
      setVisibleCount(PAGE_SIZE);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load appointment data.");
    } finally {
      setLoading(false);
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
    const covidBrands = new Set<string>();
    const covidAges = new Set<string>();
    const fluAges = new Set<string>();

    for (const row of basisFilteredRows) {
      days.add(dayOfWeekLabel(row.date));
      hourToValue.set(formatHourLabel(row.hourOfDay), row.hourOfDay);
      types.add(row.appointmentTypeName);
      for (const name of row.vaccineNames) vaccines.add(name);
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
      covidBrand: Array.from(covidBrands).sort(),
      covidAge: Array.from(covidAges).sort(),
      fluAge: Array.from(fluAges).sort(),
    };
  }, [basisFilteredRows]);

  const filteredRows = useMemo(() => applyFilters(basisFilteredRows, filters), [basisFilteredRows, filters]);
  const sortedRows = useMemo(() => sortRows(filteredRows, sortKey, sortDirection), [filteredRows, sortKey, sortDirection]);
  const sums = useMemo(() => computeSums(filteredRows), [filteredRows]);
  const groups = useMemo(() => computeGroups(filteredRows, groupBy), [filteredRows, groupBy]);
  const visibleRows = sortedRows.slice(0, visibleCount);

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

  function handleDownloadCsv() {
    const csv = rowsToCsv(filteredRows);
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

      {configured === false && (
        <p>
          Acuity credentials are not configured yet. <a href="/settings">Go to Settings</a>
        </p>
      )}

      {configured === true && loading && rows.length === 0 && <p style={styles.muted}>Loading…</p>}

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

          {groupBy !== "none" && (
            <div style={styles.groupTableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Group</th>
                    <th style={styles.th}>Appointments</th>
                    <th style={styles.th}>Vaccines</th>
                    <th style={styles.th}>% of appointments</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((groupRow) => (
                    <tr key={groupRow.group}>
                      <td style={styles.td}>{groupRow.group}</td>
                      <td style={styles.td}>{groupRow.appointments}</td>
                      <td style={styles.td}>{groupRow.vaccines}</td>
                      <td style={styles.td}>{groupRow.pctOfAppointments.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      style={{
                        ...styles.th,
                        ...COLUMN_DIVIDER,
                        ...(column.headerBackground ? { background: column.headerBackground } : {}),
                      }}
                      onClick={() => handleHeaderClick(column.key)}
                    >
                      {column.label}
                      {sortIndicator(column.key)}
                    </th>
                  ))}
                </tr>
                <tr>
                  <FilterCell>
                    <input
                      type="text"
                      style={styles.filterInput}
                      value={filters.apptDateText}
                      onChange={(event) => setFilters((f) => ({ ...f, apptDateText: event.target.value }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.day}
                      selected={filters.day}
                      onChange={(next) => setFilters((f) => ({ ...f, day: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.hour}
                      selected={filters.hour}
                      onChange={(next) => setFilters((f) => ({ ...f, hour: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <input
                      type="text"
                      style={styles.filterInput}
                      value={filters.bookedOnText}
                      onChange={(event) => setFilters((f) => ({ ...f, bookedOnText: event.target.value }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <input
                      type="text"
                      style={styles.filterInput}
                      value={filters.leadDaysText}
                      onChange={(event) => setFilters((f) => ({ ...f, leadDaysText: event.target.value }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.appointmentType}
                      selected={filters.appointmentType}
                      onChange={(next) => setFilters((f) => ({ ...f, appointmentType: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.vaccine}
                      selected={filters.vaccine}
                      onChange={(next) => setFilters((f) => ({ ...f, vaccine: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <input
                      type="text"
                      style={styles.filterInput}
                      value={filters.vaccineCountText}
                      onChange={(event) => setFilters((f) => ({ ...f, vaccineCountText: event.target.value }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.covidBrand}
                      selected={filters.covidBrand}
                      onChange={(next) => setFilters((f) => ({ ...f, covidBrand: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.covidAge}
                      selected={filters.covidAge}
                      onChange={(next) => setFilters((f) => ({ ...f, covidAge: next }))}
                    />
                  </FilterCell>
                  <FilterCell>
                    <MultiSelectFilter
                      options={filterOptions.fluAge}
                      selected={filters.fluAge}
                      onChange={(next) => setFilters((f) => ({ ...f, fluAge: next }))}
                    />
                  </FilterCell>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const leadDaysValue = computeLeadDays(row);
                  const leadDays = leadDaysValue === null ? "—" : String(leadDaysValue);
                  return (
                    <tr key={`${row.date}-${row.hourOfDay}-${row.appointmentTypeId}-${index}`}>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.date}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{dayOfWeekLabel(row.date)}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{formatHourLabel(row.hourOfDay)}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.createdDate || "—"}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{leadDays}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.appointmentTypeName}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.vaccineNames.join(", ") || "—"}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER }}>{row.vaccineNames.length}</td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.covid }}>
                        {row.covidBrand}
                      </td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.covid }}>
                        {row.covidAgeBucket}
                      </td>
                      <td style={{ ...styles.td, ...COLUMN_DIVIDER, background: GROUP_HEADER_COLORS.flu }}>
                        {row.fluAgeBucket}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {visibleCount < sortedRows.length && (
            <p>
              <button type="button" style={styles.button} onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
                Show more ({sortedRows.length - visibleCount} more)
              </button>
            </p>
          )}
        </>
      )}
    </main>
  );
}

function FilterCell({ children }: { children: ReactNode }) {
  return <th style={styles.thFilterCell}>{children}</th>;
}
