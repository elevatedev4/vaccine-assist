/**
 * Client-safe port of the pieces of the desktop app's data-entry payload
 * logic the /data-entry web page needs: the "code,lot,exp" clipboard
 * format (VaccineEntryPayload.ToClipboardPayload,
 * desktop/VaccineAssist.Desktop/PioneerEntryAutomation/VaccineEntryPayload.cs),
 * the MMDDYYYY expiration format (Models/Lot.cs's ExpirationMacroFormat),
 * FEFO active-lot selection, and multi-dose ordering
 * (DataEntryPopupViewModel.OrderByDose). KEEP IN SYNC with those desktop
 * sources — same "no shared TS/C# package boundary in this repo" reason
 * documented in lib/vaccine-group-catalog.ts.
 *
 * The web page has NO Pioneer automation (Ctrl+2 desktop-only, per
 * Will's brief) — this only builds the clipboard-fallback payload, never
 * a live/dry-run PioneerRx entry sequence.
 */

export type LotLike = {
  vaccine_id: string;
  lot_number: string;
  expiration: string; // "YYYY-MM-DD", Postgres `date` column via PostgREST
  status: string;
};

/** Lexicographic comparison is correct for "YYYY-MM-DD" strings — same
 * shape lib/chicago-date.ts's todayInChicago() returns, so callers can
 * pass that directly as `today`. */
export function isLotExpired(expiration: string, today: string): boolean {
  return expiration < today;
}

/**
 * FEFO (earliest expiration first) among ACTIVE, UNEXPIRED lots only —
 * mirrors DataEntryPopupViewModel.BuildPayloadAsync's
 * `activeLots.Where(l => !l.IsExpired).OrderBy(l => l.Expiration).FirstOrDefault()`.
 * Returns null when no such lot exists (the expiration gate: caller must
 * either add a lot or explicitly choose to skip lot/expiration).
 */
export function pickActiveUnexpiredLot<T extends LotLike>(lots: readonly T[], today: string): T | null {
  const candidates = lots
    .filter((lot) => lot.status === "active" && !isLotExpired(lot.expiration, today))
    .sort((a, b) => (a.expiration < b.expiration ? -1 : a.expiration > b.expiration ? 1 : 0));
  return candidates[0] ?? null;
}

/** "YYYY-MM-DD" -> "MMDDYYYY", matching Lot.cs's
 * `Expiration.ToString("MMddyyyy")` exactly. */
export function formatExpirationMacro(expiration: string): string {
  const [year, month, day] = expiration.split("-");
  if (!year || !month || !day) {
    throw new Error(`formatExpirationMacro: expected "YYYY-MM-DD", got "${expiration}"`);
  }
  return `${month}${day}${year}`;
}

/** The exact "code,lot,exp" format VaccineEntryPayload.ToClipboardPayload
 * produces — `lotNumber`/`expirationMacroFormat` are "" when
 * skipLotAndExpiration is true (no lot on file, staff chose to proceed
 * without one), same as the desktop's blank-lot payload. */
export function buildClipboardPayload(shortCode: string, lotNumber: string, expirationMacroFormat: string): string {
  return `${shortCode},${lotNumber},${expirationMacroFormat}`;
}

/** Orders a product's dose rows by their `dose` string parsed as an
 * integer (e.g. Gardasil's "1"/"2"/"3") so the dose step lists them in
 * order — mirrors DataEntryPopupViewModel.OrderByDose exactly, including
 * its "unparsable dose sorts last, stable among ties" fallback. */
export function orderByDose<T>(rows: readonly T[], getDose: (row: T) => string | null | undefined): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const doseA = parseDose(getDose(a.row));
      const doseB = parseDose(getDose(b.row));
      if (doseA !== doseB) return doseA - doseB;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

function parseDose(dose: string | null | undefined): number {
  if (dose === null || dose === undefined) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(dose, 10);
  return Number.isFinite(parsed) && String(parsed) === dose.trim() ? parsed : Number.MAX_SAFE_INTEGER;
}

/** "$147.99" or "—" when cents is null/undefined — matches
 * Models/Vaccine.cs's CashPriceDisplay. */
export function formatCashPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
