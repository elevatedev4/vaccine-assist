/**
 * Result-message formatter for the ⚙ menu's "Reload doses history"
 * action (app/ordering/page.tsx) — maps POST /api/administered/
 * reprocess's JSON body ({ processed, rows, matched, days, skipped })
 * to the single-line success banner shown in the same status/result
 * area as the "Upload on-hand file" action's own banner. Pure/no I/O so
 * it's directly unit-testable without mocking fetch.
 */

export type ReloadDosesHistoryResult = { rows: number; days: number; processed: number };

export function formatReloadDosesHistoryResult({ rows, days, processed }: ReloadDosesHistoryResult): string {
  return `Doses history reloaded: ${rows} row${rows === 1 ? "" : "s"} over ${days} day${days === 1 ? "" : "s"} (${processed} file${processed === 1 ? "" : "s"})`;
}
