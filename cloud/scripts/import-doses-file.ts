#!/usr/bin/env -S npx vite-node -c vitest.config.ts
// Ingests a LOCAL vaccination-log export file (bulk backfills, or a
// one-off manual import of a file Will forwarded outside the normal SES
// pipeline) through the EXACT SAME parse -> match -> store pipeline the
// SES webhook (app/api/webhooks/ses/route.ts) and
// scripts/reprocess-administered.ts use — see
// lib/administered/ingest.ts's ingestVaccinationLogMatrix. Building the
// matrix from the file's bytes reuses the SAME helpers the webhook uses
// for an xlsx/csv attachment (lib/inbound-attachments.ts's
// matrixFromXlsxBuffer / matrixFromDelimitedText), so a locally-saved
// export parses identically to how it would have been parsed had it
// arrived by email.
//
// Usage (from cloud/):
//   set -a; source .env.local; set +a
//   IMPORT_DOSES_RUN=1 npx vite-node -c vitest.config.ts scripts/import-doses-file.ts <path> [--received <ISO>] [--dry-run]
//
// IMPORT_DOSES_RUN=1 is REQUIRED (fix, 2026-09-13): under `npx vite-node
// <this file>`, process.argv[1] is vite-node's OWN bin path, not this
// script's path, so the naive "am I the entry point"
// `import.meta.url === pathToFileURL(process.argv[1]).href` check is
// always false and main() silently never ran (the script exited 0
// having done nothing). The entry-point guard below now ALSO accepts
// this env var as an explicit "yes, actually run" signal — kept in
// addition to (not instead of) the import.meta.url check so a future
// runner that DOES set argv[1] correctly still works without the env
// var. main() is exported for tests/import-doses-file.test.ts to
// exercise directly if ever needed, and to keep it out of the
// side-effecting bottom guard.
//
// --dry-run: prints the file summary (row count, date range, rows/day,
// unmatched item names) but never retains the attachment or writes to
// the administered store. The catalog is still loaded (a read) so
// "unmatched item names" is accurate even in dry-run mode.
//
// --received <ISO>: the ISO timestamp used to build the
// inbound_attachment retention key (lib/inbound-attachments.ts's
// buildAttachmentKey), matching the key shape a real SES-received email
// would get. Defaults to the file's own mtime when omitted.
//
// DUPLICATE-DAY SAFETY: retaining + ingesting the SAME file twice, or a
// later file (e.g. the routine 3am email) that overlaps a day this file
// already covered, is idempotent — lib/administered/store.ts's
// mergeRows dedupes by (at, itemName, occurrence), and `occurrence` is
// assigned fresh per ingest call starting at 0 for each (at, itemName)
// group, so two files both fully listing the same day's doses always
// converge on the SAME set of dedupe keys (their per-file occurrence
// numbering for that group has the identical SIZE 0..n-1, not a
// concatenation) — see tests/administered-store.test.ts's "an
// overlapping LATER file..." case and this repo's
// tests/import-doses-file.test.ts for the two-file scenario specific to
// this script.
//
// PDF vaccination logs are NOT supported: PioneerRx's PDF export
// reconstruction (lib/on-hand/pioneer-boh-pdf.ts's parsePioneerBohPdf)
// is built for the on-hand BOH stock table's column layout (Item Name |
// NDC/UPC | Current BOH | Stock size) — a completely different report
// shape from the vaccination log's two columns (Completed date | Item)
// — so it is NOT reusable here. A PDF vaccination log would need a new
// glyph-position table reconstruction, out of scope for this script;
// this exits with a clear message instead of guessing at a parse.
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env
// (same pattern as scripts/reprocess-administered.ts — never imports
// lib/supabase/server.ts, which is gated to Next's server runtime).

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  buildAttachmentKey,
  headerInfoFromMatrix,
  isVaccinationLogHeaderLine,
  matrixFromDelimitedText,
  matrixFromXlsxBuffer,
  persistInboundAttachment,
} from "@/lib/inbound-attachments";
import { parseVaccinationLog } from "@/lib/administered/parse";
import { matchAdministeredRows } from "@/lib/administered/match";
import { ingestVaccinationLogMatrix } from "@/lib/administered/ingest";
import { summarizeVaccinationLogRows, unmatchedItemNames } from "@/lib/administered/summarize";
import type { CatalogVaccine } from "@/lib/vaccine-matching";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing required env var ${name} (expected .env.local sourced into the shell — see this file's header).`);
    process.exit(1);
  }
  return value;
}

type FileKind = "xlsx" | "delimited" | "pdf" | "unknown";

export function detectFileKind(filePath: string): FileKind {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") return "xlsx";
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") return "delimited";
  if (ext === ".pdf") return "pdf";
  return "unknown";
}

function contentTypeForKind(kind: FileKind): string {
  if (kind === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (kind === "delimited") return "text/csv";
  return "application/octet-stream";
}

/** Builds the same 2D-array matrix shape the SES webhook builds for an
 * xlsx/csv attachment. Exported for tests so the exact same
 * bytes-in/matrix-out path the script runs is what gets exercised
 * without needing an env var or a live Supabase client. */
export function buildMatrix(kind: "xlsx" | "delimited", buffer: Buffer): unknown[][] {
  if (kind === "xlsx") return matrixFromXlsxBuffer(buffer);
  const text = buffer.toString("utf-8");
  return matrixFromDelimitedText(text, text.includes("\t") ? "\t" : ",");
}

type ParsedArgs = { filePath: string; received?: string; dryRun: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
  const dryRun = argv.includes("--dry-run");
  const receivedIdx = argv.indexOf("--received");
  const received = receivedIdx !== -1 ? argv[receivedIdx + 1] : undefined;
  const filePath = argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--received");
  if (!filePath) {
    throw new Error("Usage: import-doses-file.ts <path> [--received <ISO>] [--dry-run]");
  }
  return { filePath, received, dryRun };
}

export async function main() {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  const { filePath, received, dryRun } = parsed;

  const kind = detectFileKind(filePath);
  if (kind === "pdf") {
    console.error("PDF vaccination logs aren't supported — resend as Excel.");
    process.exit(1);
    return;
  }
  if (kind === "unknown") {
    console.error(`Unrecognized file extension for "${filePath}" — expected .xlsx/.xls or .csv/.tsv/.txt.`);
    process.exit(1);
    return;
  }

  const buffer = readFileSync(filePath);
  const matrix = buildMatrix(kind, buffer);

  const info = headerInfoFromMatrix(matrix);
  if (!info || !isVaccinationLogHeaderLine(info.headerLine)) {
    console.error(`"${filePath}" does not look like a vaccination log (header: ${info?.headerLine ?? "<empty file>"}).`);
    process.exit(1);
    return;
  }

  const { rows, skipped, skippedSamples, expanded } = parseVaccinationLog(matrix);
  const summary = summarizeVaccinationLogRows(rows);

  console.log(`File: ${filePath} (${kind}, ${buffer.length} bytes)`);
  console.log(`Header: ${info.headerLine}`);
  console.log(`Row count (doses, after quantity expansion): ${summary.rowCount}`);
  console.log(`Date range: ${summary.dateRange ? `${summary.dateRange.min} .. ${summary.dateRange.max}` : "(no rows)"}`);
  console.log("Rows per day:");
  for (const [date, count] of Object.entries(summary.perDay)) {
    console.log(`  ${date}: ${count}`);
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} row(s) with an unparseable date or blank item name:`, skippedSamples);
  }
  if (expanded > 0) {
    console.log(`Expanded ${expanded} source row(s) with an integer quantity > 1 into multiple dose rows.`);
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: vaccineRows, error: catalogError } = await supabase.from("vaccine").select("id, name, short_code, ndc");
  if (catalogError) {
    console.error(`Failed to load vaccine catalog: ${catalogError.message ?? String(catalogError)}`);
    process.exit(1);
    return;
  }
  const catalog: CatalogVaccine[] = vaccineRows ?? [];

  const matchedRows = matchAdministeredRows(rows, catalog);
  const unmatched = unmatchedItemNames(matchedRows);
  console.log(`Unmatched item names (${unmatched.length}):`);
  for (const name of unmatched) console.log(`  ${name}`);

  if (dryRun) {
    console.log("\n--dry-run: nothing retained or ingested.");
    return;
  }

  const filename = basename(filePath);
  const receivedAt = received ?? statSync(filePath).mtime.toISOString();
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const persistResult = await persistInboundAttachment(supabase, {
    receivedAt,
    from: "manual-import",
    subject: `Manual import: ${filename}`,
    filename,
    contentType: contentTypeForKind(kind),
    bytes: buffer.length,
    sha256,
    base64: buffer.toString("base64"),
  });

  let sourceKey: string;
  if (persistResult.persisted) {
    sourceKey = buildAttachmentKey(receivedAt, filename);
    console.log(`Retained as inbound attachment: ${sourceKey}`);
  } else {
    // Same "skip retention, warn, ingest directly" posture as
    // retainAttachmentsBestEffort in the webhook route — the underlying
    // dedupe (store.ts's mergeRows) never depends on this tag, it's
    // provenance only.
    sourceKey = `manual-import:${filename}:${receivedAt}`;
    console.warn(`Attachment NOT retained (reason: ${persistResult.reason}) — ingesting directly, tagged ${sourceKey}`);
  }

  const result = await ingestVaccinationLogMatrix(supabase, matrix, catalog, sourceKey);
  console.log("");
  console.log(
    JSON.stringify({ rows: result.rows, matched: result.matched, days: result.days.length, skipped: result.skipped }, null, 2)
  );
}

// Guard, not a top-level side effect: tests import this module's pure
// helpers (detectFileKind/buildMatrix/parseArgs) via the "@/scripts/..."
// alias (tsconfig's "@/*" -> repo root — see vitest.config.ts), and an
// unconditional `main()` call here would run the whole CLI (including
// process.exit calls and a requireEnv exit) as an import side effect.
// Only run when this file is the actual entry point.
//
// Fix (2026-09-13): under `npx vite-node scripts/import-doses-file.ts`,
// process.argv[1] is vite-node's OWN bin script, not this file, so
// `import.meta.url === pathToFileURL(process.argv[1]).href` is ALWAYS
// false in the one way this script is actually ever run — main() never
// executed and the script exited 0 having silently done nothing. The
// IMPORT_DOSES_RUN=1 env var (see this file's Usage comment) is the
// primary signal now; the import.meta.url check is kept as a second,
// OR'd path for a future runner that does set argv[1] to this file.
const isEntryPoint =
  process.env.IMPORT_DOSES_RUN === "1" ||
  (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
