"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { subscribeToSessionState, toSessionState, type SessionState } from "@/lib/supabase/session";
import SignInGate, { AuthLoading } from "@/app/sign-in-gate";
import { todayInChicago } from "@/lib/chicago-date";
import { buildAppointmentTable, heatmapCellBackground } from "@/lib/appointment-table";
import { buildPocTestTable } from "@/lib/poc-test-table";
import {
  MAX_RANGE_MONTHS,
  chunkScheduleRange,
  daysInclusive,
  maxEndForStart,
  mergePollResponses,
  isValidScheduleDate,
  parseScheduleRangeParams,
  pollForRange,
  validateScheduleRange,
  type ChunkPollResponse,
  type LoadedPoll,
  type ScheduleRange,
} from "@/lib/schedule-range";
import { PocTestsSection, ScheduleTableHead, formatDayLabel, renderCount, styles as tableStyles, totalCellStyle } from "../schedule-table";

/**
 * "View more" schedule (Will, 2026-10-07: "view the schedule farther out ...
 * select a date range ... default to showing 1 month out"). Same pivoted
 * table as /appointments (shared ScheduleTableHead/cell styles, same
 * buildAppointmentTable pivot) for a chosen range. The range lives in the
 * URL (?start=&end=) so it is linkable and back-button safe. The poll route
 * caps one request at 31 days, so wider ranges are fetched as sequential
 * <=31-day chunks and merged (lib/schedule-range.ts).
 */

const pageStyles = {
  controls: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem", margin: "0.5rem 0" },
  controlField: { display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.8rem", fontWeight: 600 },
  dateInput: { padding: "0.4rem 0.5rem", fontSize: "0.9rem" },
  backLink: { fontSize: "0.9rem" },
} as const;

type Progress = { done: number; total: number };

async function fetchChunk(range: ScheduleRange, token: string, force: boolean): Promise<ChunkPollResponse> {
  const forceParam = force ? "&force=1" : "";
  const response = await fetch(`/api/acuity/poll?start=${range.start}&end=${range.end}${forceParam}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Could not load appointment counts.");
  }
  return data as ChunkPollResponse;
}

function ScheduleRangeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [session, setSession] = useState<SessionState>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [loaded, setLoaded] = useState<LoadedPoll | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  // Range comes from the URL; the date inputs hold an editable draft that
  // only becomes the URL (and so triggers a fetch) on Apply.
  const { range, error: urlError } = parseScheduleRangeParams(
    searchParams.get("start"),
    searchParams.get("end"),
    todayInChicago()
  );
  const [draftStart, setDraftStart] = useState(range.start);
  const [draftEnd, setDraftEnd] = useState(range.end);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    setDraftStart(range.start);
    setDraftEnd(range.end);
    setApplyError(null);
  }, [range.start, range.end]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const supabase = getSupabaseBrowserClient();
      unsubscribe = subscribeToSessionState(supabase, (state) => {
        setSession(state);
        setAuthChecked(true);
        if (!state) {
          setLoaded(null);
          setLoadError(null);
        }
      });
    } catch {
      setAuthChecked(true);
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Newest request wins: a slow earlier range must never overwrite the
  // table for the range the user has since moved on to.
  const requestIdRef = useRef(0);

  const loadRange = useCallback(async (token: string, target: ScheduleRange, force: boolean) => {
    const requestId = ++requestIdRef.current;
    const chunks = chunkScheduleRange(target);
    setLoading(true);
    setLoadError(null);
    setProgress({ done: 0, total: chunks.length });
    try {
      const parts: ChunkPollResponse[] = [];
      for (const chunk of chunks) {
        const part = await fetchChunk(chunk, token, force);
        if (requestId !== requestIdRef.current) return;
        parts.push(part);
        setProgress({ done: parts.length, total: chunks.length });
        if (!part.configured) break;
      }
      setLoaded({ range: target, poll: mergePollResponses(parts) });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setLoaded(null);
      setLoadError(err instanceof Error ? err.message : "Could not load appointment counts.");
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setProgress(null);
      }
    }
  }, []);

  const accessToken = session?.accessToken ?? null;
  useEffect(() => {
    if (accessToken) void loadRange(accessToken, { start: range.start, end: range.end }, false);
  }, [accessToken, range.start, range.end, loadRange]);

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

  function handleApply(event: FormEvent) {
    event.preventDefault();
    const result = validateScheduleRange(draftStart, draftEnd);
    if (!result.ok) {
      setApplyError(result.error);
      return;
    }
    setApplyError(null);
    // An invalid URL (urlError) still navigates, so the URL becomes valid and the message clears.
    if (!urlError && result.range.start === range.start && result.range.end === range.end) {
      // Same URL -> no navigation -> no effect; re-run explicitly.
      if (accessToken) void loadRange(accessToken, result.range, false);
      return;
    }
    router.push(`/appointments/range?start=${result.range.start}&end=${result.range.end}`);
  }

  if (!authChecked) {
    return <AuthLoading />;
  }

  if (!session) {
    return (
      <SignInGate
        description="Use the shared pharmacy login to view appointment counts."
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

  // Only ever the poll fetched for THIS range (see pollForRange).
  const poll = pollForRange(loaded, range);
  const days = daysInclusive(range.start, range.end);
  const table = buildAppointmentTable(poll?.counts ?? [], days);
  // Merged across every chunk, so it covers the whole chosen range.
  const testTable = buildPocTestTable(poll?.testCounts ?? [], days);

  let dailyScaleMax = 0;
  for (const row of table.rows) {
    for (const day of table.days) dailyScaleMax = Math.max(dailyScaleMax, row.countsByDay[day] ?? 0);
  }
  let totalsScaleMax = 0;
  for (const day of table.days) totalsScaleMax = Math.max(totalsScaleMax, table.dailyTotals[day] ?? 0);
  let rangeScaleMax = 0;
  for (const row of table.rows) rangeScaleMax = Math.max(rangeScaleMax, row.total);

  const maxEnd = maxEndForStart(isValidScheduleDate(draftStart) ? draftStart : range.start);

  return (
    <main style={tableStyles.mainWide}>
      <h1 style={tableStyles.heading}>
        Appointments: {formatDayLabel(range.start)} to {formatDayLabel(range.end)} ({days.length} days)
      </h1>

      <p style={tableStyles.actionsRow}>
        <a href="/appointments" style={pageStyles.backLink}>
          &larr; Back to the 7-day schedule
        </a>
      </p>

      <form onSubmit={handleApply} style={pageStyles.controls} noValidate>
        <label style={pageStyles.controlField}>
          Start date
          <input
            type="date"
            value={draftStart}
            onChange={(event) => setDraftStart(event.target.value)}
            style={pageStyles.dateInput}
          />
        </label>
        <label style={pageStyles.controlField}>
          End date
          <input
            type="date"
            value={draftEnd}
            min={draftStart || undefined}
            max={maxEnd}
            onChange={(event) => setDraftEnd(event.target.value)}
            style={pageStyles.dateInput}
          />
        </label>
        <button type="submit" style={tableStyles.button} disabled={loading}>
          Apply
        </button>
        <button
          type="button"
          style={tableStyles.button}
          disabled={loading}
          onClick={() => void loadRange(session.accessToken, range, true)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {poll?.asOf && (
          <span style={tableStyles.muted}>
            Data as of {new Date(poll.asOf).toLocaleString()}
            {poll.cacheHit ? " (cached)" : ""}
          </span>
        )}
      </form>
      <p style={tableStyles.muted}>Up to {MAX_RANGE_MONTHS} months at a time. Defaults to the next month.</p>

      {urlError && <p style={tableStyles.error}>{urlError} Showing the default range instead.</p>}
      {applyError && <p style={tableStyles.error}>{applyError}</p>}
      {loadError && <p style={tableStyles.error}>{loadError}</p>}

      {loading && progress && (
        <p style={tableStyles.muted} role="status">
          Loading appointments… {progress.done} of {progress.total}
          {progress.total > 1 ? " segments" : ""}
        </p>
      )}

      {poll && !poll.configured && (
        <p>
          {poll.message ?? "Acuity credentials are not configured yet."}{" "}
          <a href={poll.settingsUrl ?? "/settings"}>Go to Settings</a>
        </p>
      )}

      {poll?.configured && poll.possiblyTruncated && (
        <p style={tableStyles.warning}>100+ appointments in part of this range — counts may be incomplete.</p>
      )}

      {poll && poll.configured && (
        <div style={tableStyles.tableWrap}>
          <table style={tableStyles.table}>
            <ScheduleTableHead columns={table.columns} />
            <tbody>
              <tr>
                <td style={tableStyles.sumRowLabelLast}>Range total</td>
                <td style={tableStyles.sumRowCellLast}>{table.grandTotal}</td>
                {table.rows.map((row, index) => (
                  <td
                    key={table.columns[index].vaccineName}
                    style={{
                      ...tableStyles.sumRowCellLast,
                      borderLeft: "1px solid #c9c9c9",
                      background: heatmapCellBackground(row.total, rangeScaleMax),
                    }}
                  >
                    {row.total}
                  </td>
                ))}
              </tr>
              {table.days.map((day) => (
                <tr key={day}>
                  <td style={tableStyles.tdType}>{formatDayLabel(day)}</td>
                  <td style={totalCellStyle(tableStyles.totalCell, heatmapCellBackground(table.dailyTotals[day], totalsScaleMax))}>
                    {table.dailyTotals[day]}
                  </td>
                  {table.columns.map((column, index) => renderCount(column, table.rows[index].countsByDay[day], dailyScaleMax))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {poll && poll.configured && <PocTestsSection testTable={testTable} />}
    </main>
  );
}

/** Real default export — useSearchParams requires a Suspense boundary. */
export default function ScheduleRangePage() {
  return (
    <Suspense fallback={<AuthLoading />}>
      <ScheduleRangeContent />
    </Suspense>
  );
}
