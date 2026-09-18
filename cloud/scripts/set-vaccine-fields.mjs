#!/usr/bin/env node
// Sets one-off vaccine catalog fields by name (V-T45 prep, Will
// 2026-09-16, via the coordinator) — a smaller, single-product sibling of
// scripts/apply-lot-list.mjs (Will's whole-list reconciliation script)
// for the case where he just wants to correct one product's NDC and/or
// doses-per-package without building a TSV. Same env/Supabase access
// pattern and the same dry-run-by-default / --apply convention as that
// script.
//
// SAFE BY DEFAULT: dry-run unless --apply is passed. Dry-run prints the
// matched vaccine row(s) and a current-vs-requested table, then exits 0
// without writing anything. NEVER run --apply from an agent session —
// Will runs it himself after reviewing the dry-run output, same rule as
// apply-lot-list.mjs.
//
// Usage:
//   node scripts/set-vaccine-fields.mjs --name "<vaccine name substring>" --ndc 12345-678-90
//   node scripts/set-vaccine-fields.mjs --name "<vaccine name substring>" --doses-per-package 10
//   node scripts/set-vaccine-fields.mjs --name "<vaccine name substring>" --short-code mflusiva
//   node scripts/set-vaccine-fields.mjs --name "<vaccine name substring>" --ndc 12345-678-90 --doses-per-package 10 --apply
//
// --short-code (V-T50, Will's verbatim feedback, 2026-09-18 — "the
// shortcode is mflusiva for the macro code") writes vaccine.short_code,
// the same column lib/macro-catalog.ts's lookupMacroCatalog keys its
// catalog off of. Same dry-run/--apply convention as --ndc above.
// Validated lowercase-alnum-only (matching how every real short_code in
// supabase/seed/vaccines.sql is formatted) and refused outright if
// ANOTHER vaccine row already has that exact short_code — the column is
// unique, so writing a duplicate would fail at the DB (or worse, silently
// break lookupMacroCatalog's exact-match branch for both rows) — same
// "don't guess/don't clobber" posture as the --name multi-match refusal
// below.
//
// --name matches case-insensitively as a SUBSTRING of vaccine.name (not
// exact) — e.g. "flusiva" matches "mFLUSIVA 2026-27". If that matches
// zero vaccine rows, or more than one, this REFUSES to do anything
// (prints every match it found, if any, so the name can be narrowed) —
// same "don't guess which row" posture as apply-lot-list.mjs's UNMAPPED
// reporting.
//
// --ndc is validated/formatted by lib/ndc.ts's formatNdcForStorage — the
// EXACT function PATCH /api/vaccines/[id] (app/api/vaccines/[id]/route.ts)
// uses for its own `ndc` field — imported directly rather than copied,
// since (unlike apply-lot-list.mjs's deriveShortCode copy, which avoids a
// route file that pulls in "next/server") lib/ndc.ts has no Next.js
// dependency at all and Node (v22.18+/23.6+, confirmed against the
// v26.5.0 this was written/run on) can load a plain .ts module like this
// directly via its built-in type-stripping — no build step, no new
// dependency. --apply writes ONLY vaccine.ndc, via the same
// `.from("vaccine").update({ ndc }).eq("id", id)` shape the route uses.
//
// --doses-per-package is DELIBERATELY NEVER WRITTEN TO THE DATABASE.
// The `vaccine` table has no doses-per-package column (see
// supabase/migrations/0001_init.sql and 0009_lots_bud_vaccine_defaults.sql
// — the only additive vaccine columns there are quantity/directions,
// which are Pioneer prescription-entry defaults like "0.5 mL" or "1 dose
// IM x1", a completely different thing from a package's dose count) and
// PATCH /api/vaccines/[id] has no field for it either. The Ordering
// page's "Doses/pkg" number instead comes from a hardcoded, code-only
// catalog — lib/vaccine-product-catalog.ts's own header comment says so
// explicitly: "NOT derived from any table in this schema (`vaccine` has
// no doses-per-package column)" — matched by NDC/name, not by vaccine id,
// and edited by changing that file's CATALOG array in a code change, not
// a data change. So --doses-per-package here is REPORT ONLY: this prints
// the requested value and a pointer to the exact file/row to hand-edit,
// and never touches Supabase for it, with or without --apply. (This is a
// real gap between the V-T45 brief's assumption of one editable "doses
// per package" column and how the app actually stores that number —
// flagged here rather than guessing and silently writing the wrong
// column, e.g. `quantity`, which would corrupt an unrelated
// prescription-entry field.)
//
// NO PHI: this script only ever touches vaccine catalog data (name, NDC)
// — no patient data of any kind exists in this table.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { formatNdcForStorage } from "../lib/ndc.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads KEY=VALUE lines from a .env-style file into `target` (default
 * process.env), WITHOUT overwriting a key that's already set. COPIED
 * from scripts/apply-lot-list.mjs (same convention: a tiny hand-rolled
 * parser rather than a new `dotenv` dependency) instead of imported, so
 * this script has no dependency on that one — same reasoning
 * apply-lot-list.mjs itself gives for copying deriveShortCode rather than
 * importing across a route boundary. KEEP IN SYNC if that copy changes.
 * Silently does nothing if the file doesn't exist.
 *
 * @param {string} filePath
 * @param {Record<string, string | undefined>} [target]
 */
export function loadEnvFile(filePath, target = process.env) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (target[key] === undefined) target[key] = value;
  }
}

/** True if `name` contains `substring`, case-insensitive. Pure/unit-
 * testable. */
export function nameMatchesSubstring(name, substring) {
  return name.toLowerCase().includes(substring.toLowerCase());
}

/** True if `code` is a valid short_code: lowercase letters/digits only,
 * non-empty. Pure/unit-testable — same validation whether or not the DB
 * is reachable, so --short-code's parse/validation path can be proven
 * without Supabase (see this file's V-T50 header note). */
export function isValidShortCode(code) {
  return typeof code === "string" && /^[a-z0-9]+$/.test(code);
}

/** Finds another vaccine row (not `excludeId`) whose short_code already
 * equals `shortCode` (case-insensitive) — short_code is unique, so this
 * is the "don't write a duplicate" check --short-code refuses on. Pure/
 * unit-testable. Returns the conflicting row, or null if none. */
export function findShortCodeConflict(vaccines, shortCode, excludeId) {
  const lower = shortCode.toLowerCase();
  return (
    vaccines.find((v) => v.id !== excludeId && (v.short_code ?? "").toLowerCase() === lower) ?? null
  );
}

function parseArgs(argv) {
  const args = { name: null, ndc: null, dosesPerPackage: null, shortCode: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--name") args.name = argv[++i];
    else if (arg.startsWith("--name=")) args.name = arg.slice("--name=".length);
    else if (arg === "--ndc") args.ndc = argv[++i];
    else if (arg.startsWith("--ndc=")) args.ndc = arg.slice("--ndc=".length);
    else if (arg === "--doses-per-package") args.dosesPerPackage = argv[++i];
    else if (arg.startsWith("--doses-per-package=")) args.dosesPerPackage = arg.slice("--doses-per-package=".length);
    else if (arg === "--short-code") args.shortCode = argv[++i];
    else if (arg.startsWith("--short-code=")) args.shortCode = arg.slice("--short-code=".length);
  }
  return args;
}

function printTable(rows, columns) {
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r) => String(r[col.key] ?? "").length))
  );
  const printRow = (cells) =>
    console.log(cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  |  "));

  printRow(columns.map((c) => c.header));
  printRow(widths.map((w) => "-".repeat(w)));
  for (const row of rows) {
    printRow(columns.map((c) => row[c.key] ?? ""));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    console.error(
      'Usage: node scripts/set-vaccine-fields.mjs --name "<vaccine name substring>" [--ndc 12345-678-90] [--doses-per-package N] [--short-code mflusiva] [--apply]'
    );
    process.exit(1);
  }
  if (args.ndc === null && args.dosesPerPackage === null && args.shortCode === null) {
    console.error("Nothing to do — pass --ndc, --doses-per-package, and/or --short-code.");
    process.exit(1);
  }
  if (args.shortCode !== null && !isValidShortCode(args.shortCode)) {
    console.error(
      `\n--short-code ${JSON.stringify(args.shortCode)} is invalid — short codes are lowercase letters/digits only (e.g. "mflusiva"). Refusing to proceed.`
    );
    process.exit(1);
  }

  loadEnvFile(path.join(__dirname, "..", ".env.local"));

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (checked process.env and cloud/.env.local). " +
        "Set them (see .env.example) before running this script."
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const { data: vaccines, error: vaccinesError } = await supabase
    .from("vaccine")
    .select("id, name, dose, short_code, active, ndc");
  if (vaccinesError) throw new Error(`Loading vaccine rows failed: ${vaccinesError.message}`);

  const matches = (vaccines ?? []).filter((v) => nameMatchesSubstring(v.name, args.name));

  console.log(`\nMatched ${matches.length} vaccine row(s) for name substring ${JSON.stringify(args.name)}:\n`);
  if (matches.length > 0) {
    printTable(matches, [
      { key: "id", header: "id" },
      { key: "name", header: "name" },
      { key: "dose", header: "dose" },
      { key: "short_code", header: "short_code" },
      { key: "active", header: "active" },
      { key: "ndc", header: "ndc" },
    ]);
  }

  if (matches.length === 0) {
    console.error("\nNo matching vaccine — refusing to do anything. Check the spelling/substring and try again.");
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(
      `\n${matches.length} vaccines matched — refusing to guess which one. Narrow --name so it matches exactly one row.`
    );
    process.exit(1);
  }

  const vaccine = matches[0];

  if (args.shortCode !== null) {
    const conflict = findShortCodeConflict(vaccines ?? [], args.shortCode, vaccine.id);
    if (conflict) {
      console.error(
        `\n--short-code ${JSON.stringify(args.shortCode)} is already used by ${conflict.name} (id ${conflict.id}) — ` +
          "short_code is unique. Refusing to proceed."
      );
      process.exit(1);
    }
  }

  // --- Build the current-vs-requested field table ---
  const fieldRows = [];
  /** @type {string | null} */
  let formattedNdc = null;
  if (args.ndc !== null) {
    formattedNdc = formatNdcForStorage(args.ndc);
    if (!formattedNdc) {
      console.error(`\n--ndc ${JSON.stringify(args.ndc)} is not 10-11 digits (dashes optional) — refusing to proceed.`);
      process.exit(1);
    }
    fieldRows.push({
      field: "ndc",
      current: vaccine.ndc ?? "(none)",
      requested: formattedNdc,
      writesTo: "vaccine.ndc (via PATCH /api/vaccines/[id]'s own formatNdcForStorage)",
    });
  }
  if (args.dosesPerPackage !== null) {
    fieldRows.push({
      field: "doses-per-package",
      current: "(not a database column — see note below)",
      requested: args.dosesPerPackage,
      writesTo: "NOTHING — not applied to Supabase, see note below",
    });
  }
  if (args.shortCode !== null) {
    fieldRows.push({
      field: "short_code",
      current: vaccine.short_code ?? "(none)",
      requested: args.shortCode,
      writesTo: "vaccine.short_code",
    });
  }

  console.log("\n=== Current vs requested ===");
  printTable(fieldRows, [
    { key: "field", header: "Field" },
    { key: "current", header: "Current" },
    { key: "requested", header: "Requested" },
    { key: "writesTo", header: "Writes to" },
  ]);

  if (args.dosesPerPackage !== null) {
    console.log(
      "\nNOTE: doses-per-package is not stored on the `vaccine` table (see this script's header comment) — " +
        "it lives in lib/vaccine-product-catalog.ts's hardcoded CATALOG array, matched by NDC/name, not by " +
        "vaccine id. This script CANNOT write it, with or without --apply. To change it, hand-edit that " +
        `file's entry for "${vaccine.name}" (or add one if it has none yet).`
    );
  }

  if (!args.apply) {
    console.log(
      "\nDry run only — no changes written. Re-run with --apply to write the ndc/short_code change(s) above (if any)."
    );
    process.exit(0);
  }

  /** @type {Record<string, string>} */
  const update = {};
  if (formattedNdc !== null) update.ndc = formattedNdc;
  if (args.shortCode !== null) update.short_code = args.shortCode;

  if (Object.keys(update).length === 0) {
    console.log("\nNothing to write to the database (only --doses-per-package was given, which has no DB column).");
    process.exit(0);
  }

  console.log("\nApplying...");
  const { error: updateError } = await supabase.from("vaccine").update(update).eq("id", vaccine.id);
  if (updateError) throw new Error(`Updating ${Object.keys(update).join(", ")} for ${vaccine.name}: ${updateError.message}`);
  console.log(
    `Updated ${vaccine.name} (id ${vaccine.id}): ${Object.entries(update)
      .map(([field, value]) => `${field} -> ${value}`)
      .join(", ")}.`
  );
  process.exit(0);
}

// Only run main() when executed directly (not when imported for unit
// tests — loadEnvFile/nameMatchesSubstring/isValidShortCode/
// findShortCodeConflict are exported above for that).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
