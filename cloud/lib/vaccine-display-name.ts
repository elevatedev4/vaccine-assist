/**
 * Adds a manufacturer prefix to COVID vaccine names for display (Will
 * 2026-09-24, verbatim: "Vaccine names in assist app: Add Pfizer and
 * Moderna to the names for Spikevax, mNexspike, and Comirnaty. Start
 * with mfg name then go to the drug name itself, only on covid
 * vaccines."). Pure/no I/O, display-only — the underlying stored name
 * (matched by lib/vaccine-product-catalog.ts and
 * app/api/ordering/recommendation/route.ts, aliased by the screener,
 * and read verbatim by the desktop app) must never change, so callers
 * apply this ONLY where a vaccine name is rendered to a human, never
 * to a value used for matching, sorting keys, API payloads, or stored
 * data.
 *
 * Case-insensitive on the match; the season/age suffix already on the
 * name (e.g. "Comirnaty 2026-27 12+") is preserved verbatim after the
 * prefix. Idempotent: a name that already starts with "Pfizer" or
 * "Moderna" (any case) is returned unchanged rather than double-prefixed.
 * Every non-COVID name passes through untouched.
 */

const COVID_PREFIXES: { test: RegExp; prefix: string }[] = [
  { test: /^comirnaty/i, prefix: "Pfizer" },
  { test: /^spikevax/i, prefix: "Moderna" },
  { test: /^mnexspike/i, prefix: "Moderna" },
];

const ALREADY_PREFIXED = /^(pfizer|moderna)\b/i;

export function vaccineDisplayName(name: string): string {
  if (ALREADY_PREFIXED.test(name)) return name;

  for (const { test, prefix } of COVID_PREFIXES) {
    if (test.test(name)) return `${prefix} ${name}`;
  }

  return name;
}
