#!/usr/bin/env node
// Applies Will's authoritative "current lot numbers" list (V-T21 item 3,
// 2026-09-08) to the live Supabase `vaccine`/`lot` tables — replaces
// manually reconciling the Lots screen row by row against a paper/TSV
// list. Talks to Supabase directly with the SERVICE-ROLE key (never the
// desktop/cloud app's own bearer-token auth — this is an out-of-band
// admin script, run from a terminal, not a request the apps make), so it
// bypasses RLS entirely — treat it with the same care as a direct SQL
// migration.
//
// SAFE BY DEFAULT: dry-run unless --apply is passed. Dry-run prints a
// full before/after table of every change this WOULD make and exits 0
// without writing anything. NEVER run --apply from an agent session —
// Will runs it himself, after reviewing the dry-run table (see the
// worktree brief this script was written against, item 3: "NEVER run
// --apply yourself — I run it after Will approves in the terminal").
//
// Usage:
//   node scripts/apply-lot-list.mjs --file /path/to/lot-list.tsv           # dry run (default)
//   node scripts/apply-lot-list.mjs --file /path/to/lot-list.tsv --apply   # writes for real
//
// Input: a tab-separated file with a header row `Brand\tLOT\tEXP` — see
// ALIASES below for the exact brand-label vocabulary this script expects
// (Will's own labels, which differ from `vaccine.name` — e.g. "Moderna
// 12+ NEXSPIKE" is the mNEXSPIKE product, "MMR" is MMR-II, etc.).
//
// RULES (Will's brief, verbatim, item 3):
//   - "Add Comirnaty 2026-27 and mNexspike 2026-27 and remove the 2025-26
//     versions" -> RENAMED in place (keeping short_code/NDC), not
//     inserted as new rows: any vaccine.name starting with "mNEXSPIKE" is
//     renamed to exactly "mNEXSPIKE 2026-27"; any COVID-group vaccine
//     whose name contains "2025-26" has that replaced with "2026-27"
//     (matches "Comirnaty 2025-26 12+" -> "Comirnaty 2026-27 12+", and
//     any OTHER 2025-26-labeled COVID row the live DB happens to have).
//   - "Here are the current lot numbers... update all lot numbers...
//     remove any that are not listed here": for each listed brand WITH a
//     lot, upsert that lot (matching by exact lot_number against the
//     vaccine's existing lots — if found, its expiration is updated and
//     its beyond_use_date/note are LEFT ALONE; if not found, a new lot
//     row is inserted) and DELETE every OTHER lot on file for that
//     vaccine.
//   - "Any vaccines without a lot entered here, mark them as not active
//     ... Leave vaccines in the lots screen where we can add them later":
//     for each listed brand with NO lot, every one of its existing lots
//     is deleted, then `active` is set to whether it has any lot
//     REMAINING (i.e. false, unless something outside this run's own
//     deletions is still on file) — the vaccine ROW itself is never
//     touched beyond the active flag, so it stays visible on the Lots/
//     Active-vaccines screens to add a lot to later.
//   - Every vaccine row NOT matched by any brand in the list at all is
//     deactivated and has its lots deleted too (same "remove any that
//     are not listed here" instruction, applied to whole products this
//     list never mentions).
//
// MULTI-DOSE PRODUCTS (judgment call, flagged in the report): several
// brands (Engerix 20, Gardasil, MMR, Priorix, Shingrix, Vaqta adult) have
// MULTIPLE vaccine rows sharing the same product name but a different
// `dose` value (1/2/3 — the data-entry guided flow's per-dose picker,
// see desktop DataEntryPopupViewModel.SelectProduct/BuildDoseOptions).
// Will's list gives ONE lot per brand/product, not per dose row — a
// physical shipment's lot is the same vial/lot regardless of which dose
// number is being administered. This script therefore applies the SAME
// lot action to EVERY dose-variant row sharing that resolved product
// name, rather than picking just one — this also happens to fix the
// "orphan duplicate lot" issue DataEntryPopupViewModel.
// FindActiveLotForVaccineAsync's doc comment describes (a lot previously
// attached to only ONE of several same-named dose rows).
//
// DUPLICATE ROWS: separately (and NOT auto-deleted — listed only, for
// Will to review/delete by hand), this reports vaccine rows that share
// the exact same (name, dose) with another row, currently have zero lots,
// and are not referenced by any physician_rule — real orphan duplicates,
// as opposed to the legitimate same-name-different-dose rows above.
//
// NO PHI: this script only ever touches vaccine/lot inventory data
// (product names, lot numbers, expirations) — no patient data of any
// kind exists in these tables.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------
// Brand alias table — Will's TSV brand label -> the substring(s) that
// must ALL appear (case-insensitive) in a live vaccine.name (evaluated
// AFTER the mNEXSPIKE/2025-26 renames above) for that row to be
// considered a match for this brand. A brand matching ZERO rows is
// printed as UNMAPPED, never silently skipped or guessed at.
//
// Every entry here was chosen from the CURRENT supabase/seed/vaccines.sql
// formulary (2026-09-04) plus Will's own brief. Several are deliberately
// EXPECTED to come back unmapped per the brief's own note ("some brands
// like Fluarix PFS/Flulaval/Pneumovax 23 may not exist as vaccine rows")
// — that's the dry-run doing its job, not a bug in this table.
// ---------------------------------------------------------------------
const ALIASES = [
  { brand: "Moderna 3-11 Spikevax 25-26", requires: ["Spikevax"] },
  { brand: "Moderna 12+ NEXSPIKE", requires: ["NEXSPIKE"] },
  // Pfizer/Comirnaty age tiers: TWO alias entries per brand (a brand may
  // have more than one — a vaccine row matches if EITHER's `requires`
  // list is fully satisfied). Confirmed against a live dry run
  // (2026-09-08): this pharmacy's actual `vaccine` table names the 5-11
  // and 3-4 tiers literally "Pfizer 5-11"/"Pfizer 3-4" (NOT
  // "Comirnaty ..." — the checked-in supabase/seed/vaccines.sql is stale
  // relative to live data here), while the 12+ tier IS still named
  // "Comirnaty ... 12+". Both forms are kept per brand so this table
  // keeps working if the naming is ever made consistent later.
  { brand: "Pfizer 5-11", requires: ["Comirnaty", "5-11"] },
  { brand: "Pfizer 5-11", requires: ["Pfizer", "5-11"] },
  { brand: "Pfizer 12+", requires: ["Comirnaty", "12+"] },
  { brand: "Pfizer 12+", requires: ["Pfizer", "12+"] },
  { brand: "Pfizer 3-4", requires: ["Comirnaty", "6mo"] },
  { brand: "Pfizer 3-4", requires: ["Pfizer", "3-4"] },
  { brand: "Afluria MDV", requires: ["Afluria MDV"] },
  { brand: "Afluria PFS", requires: ["Afluria PFS"] },
  { brand: "Flucelvax MDV", requires: ["Flucelvax MDV"] },
  { brand: "Flucelvax PFS", requires: ["Flucelvax PFS"] },
  { brand: "Fluad", requires: ["Fluad"] },
  { brand: "Fluarix PFS", requires: ["Fluarix PFS"] },
  { brand: "Fluzone PFS", requires: ["Fluzone PFS"] },
  { brand: "Fluzone HD", requires: ["Fluzone HD"] },
  { brand: "Flulaval", requires: ["Flulaval"] },
  { brand: "FluMist", requires: ["FluMist"] },
  { brand: "Arexvy", requires: ["Arexvy"] },
  { brand: "Boostrix", requires: ["Boostrix"] },
  { brand: "Shingrix", requires: ["Shingrix"] },
  // "Engerix 20"->Engerix-B 20 (brief's own alias note) — matches every
  // Engerix dose-variant row (1/2/3) sharing that product name.
  { brand: "Engerix 20", requires: ["Engerix"] },
  { brand: "Prevnar 20", requires: ["Prevnar 20"] },
  { brand: "Pneumovax 23", requires: ["Pneumovax"] },
  { brand: "Gardasil", requires: ["Gardasil"] },
  { brand: "Menveo", requires: ["Menveo"] },
  // "Vaqta adult"->Vaqta (brief's own alias note).
  { brand: "Vaqta adult", requires: ["Vaqta"] },
  { brand: "Typhim Vi", requires: ["Typhim"] },
  // "MMR"->M-M-R II/MMR-II (brief's own alias note) — Priorix is a
  // SEPARATE product/brand below, not an MMR alias.
  { brand: "MMR", requires: ["MMR"] },
  { brand: "Abrysvo", requires: ["Abrysvo"] },
  { brand: "Priorix", requires: ["Priorix"] },
  { brand: "Capvaxive", requires: ["Capvaxive"] },
];

const COVID_KEYWORDS = ["comirnaty", "spikevax", "nexspike", "novavax"];

function isCovidRow(name) {
  const lower = name.toLowerCase();
  return COVID_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Applies the mNEXSPIKE / 2025-26->2026-27 COVID renames to one vaccine
 * row's name. Pure — takes/returns a string, no DB access — so it's
 * directly unit-testable. */
export function computeEffectiveName(name) {
  if (/^mNEXSPIKE/i.test(name)) {
    return "mNEXSPIKE 2026-27";
  }
  if (isCovidRow(name) && name.includes("2025-26")) {
    return name.replace(/2025-26/g, "2026-27");
  }
  return name;
}

/** True if `name` satisfies one alias's `requires` list — every required
 * substring must be present, case-insensitive. Pure/unit-testable. */
export function nameMatchesAlias(name, requires) {
  const lower = name.toLowerCase();
  return requires.every((s) => lower.includes(s.toLowerCase()));
}

/** Parses Will's TSV (header `Brand\tLOT\tEXP`, tab-separated, blank
 * LOT/EXP cells mean "no lot for this brand right now"). Pure — no file
 * I/O — so it's unit-testable against an inline string fixture. Throws on
 * a missing/malformed header so a wrong file is caught immediately rather
 * than silently producing zero rows. */
export function parseLotListTsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("Empty TSV — nothing to parse.");
  }
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  if (header[0] !== "brand" || header[1] !== "lot" || header[2] !== "exp") {
    throw new Error(`Expected header "Brand\\tLOT\\tEXP", got: ${JSON.stringify(lines[0])}`);
  }

  return lines.slice(1).map((line, index) => {
    const cells = line.split("\t");
    const brand = (cells[0] ?? "").trim();
    const lot = (cells[1] ?? "").trim();
    const exp = (cells[2] ?? "").trim();
    if (!brand) {
      throw new Error(`Row ${index + 2}: blank Brand cell.`);
    }
    return { brand, lot: lot || null, exp: exp || null };
  });
}

/** Converts an M/D/YY, M/D/YYYY, MM/DD/YY, or MM/DD/YYYY date string into
 * a Postgres-ready ISO "YYYY-MM-DD" string. Two-digit years are treated
 * as 20xx (every date on Will's list is a near-future vaccine expiration
 * in the 2025-2028 range). Pure/unit-testable. Throws on anything it
 * can't parse rather than silently producing a wrong date. */
export function parseExpirationToIso(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unrecognized date format: ${JSON.stringify(value)} (expected M/D/YY or M/D/YYYY).`);
  }
  const [, monthStr, dayStr, yearStr] = match;
  const month = Number(monthStr);
  const day = Number(dayStr);
  let year = Number(yearStr);
  if (yearStr.length === 2) year += 2000;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Date out of range: ${JSON.stringify(value)}.`);
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Loads KEY=VALUE lines from a .env-style file into `target` (default
 * process.env), WITHOUT overwriting a key that's already set (so real
 * shell-exported env vars always win over the file) — a tiny hand-rolled
 * parser rather than adding the `dotenv` package as a new dependency,
 * matching this repo's existing dependency-light scripts (no other file
 * under cloud/scripts/ pulls in dotenv either). Silently does nothing if
 * the file doesn't exist.
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

function parseArgs(argv) {
  const args = { file: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--file") args.file = argv[++i];
    else if (arg.startsWith("--file=")) args.file = arg.slice("--file=".length);
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
  if (!args.file) {
    console.error("Usage: node scripts/apply-lot-list.mjs --file <path-to-lot-list.tsv> [--apply]");
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

  const tsvContent = readFileSync(path.resolve(args.file), "utf8");
  const listRows = parseLotListTsv(tsvContent);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const [{ data: vaccines, error: vaccinesError }, { data: lots, error: lotsError }, { data: rules, error: rulesError }] =
    await Promise.all([
      supabase.from("vaccine").select("id, name, dose, short_code, active"),
      supabase.from("lot").select("id, vaccine_id, lot_number, expiration, status, note, beyond_use_date"),
      supabase.from("physician_rule").select("vaccine_id"),
    ]);

  if (vaccinesError) throw new Error(`Loading vaccine rows failed: ${vaccinesError.message}`);
  if (lotsError) throw new Error(`Loading lot rows failed: ${lotsError.message}`);
  if (rulesError) throw new Error(`Loading physician_rule rows failed: ${rulesError.message}`);

  const lotsByVaccineId = new Map();
  for (const lot of lots ?? []) {
    const list = lotsByVaccineId.get(lot.vaccine_id) ?? [];
    list.push(lot);
    lotsByVaccineId.set(lot.vaccine_id, list);
  }

  const vaccineIdsWithRules = new Set((rules ?? []).map((r) => r.vaccine_id).filter(Boolean));

  // Effective (post-rename) name per row, computed once up front so every
  // alias/duplicate check below is consistent with what the rename would
  // actually produce.
  const rows = (vaccines ?? []).map((v) => ({
    ...v,
    effectiveName: computeEffectiveName(v.name),
  }));

  // --- Brand -> matched vaccine row(s) ---
  const matchedVaccineIds = new Set();
  const unmappedBrands = [];
  /** @type {Array<{ brand: string, lot: string|null, exp: string|null, vaccine: any }>} */
  const brandVaccinePairs = [];

  for (const listRow of listRows) {
    // A brand may have more than one ALIASES entry (alternate naming
    // patterns — see the Pfizer/Comirnaty entries' own comment above); a
    // vaccine row counts as a match if it satisfies ANY of them.
    const aliasesForBrand = ALIASES.filter((a) => a.brand === listRow.brand);
    if (aliasesForBrand.length === 0) {
      unmappedBrands.push(`${listRow.brand} (no alias entry in this script at all — add one)`);
      continue;
    }
    const matches = rows.filter((v) => aliasesForBrand.some((alias) => nameMatchesAlias(v.effectiveName, alias.requires)));
    if (matches.length === 0) {
      unmappedBrands.push(listRow.brand);
      continue;
    }
    for (const vaccine of matches) {
      matchedVaccineIds.add(vaccine.id);
      brandVaccinePairs.push({ brand: listRow.brand, lot: listRow.lot, exp: listRow.exp, vaccine });
    }
  }

  // --- Build the plan ---
  const plan = [];

  for (const { brand, lot, exp, vaccine } of brandVaccinePairs) {
    const rename = vaccine.name !== vaccine.effectiveName;
    const existingLots = lotsByVaccineId.get(vaccine.id) ?? [];

    if (lot) {
      const expirationIso = parseExpirationToIso(exp);
      const matchingExisting = existingLots.find((l) => l.lot_number.trim() === lot.trim());
      const otherLots = existingLots.filter((l) => l !== matchingExisting);

      plan.push({
        brand,
        name: vaccine.effectiveName,
        rename: rename ? `${vaccine.name} -> ${vaccine.effectiveName}` : "",
        action: matchingExisting ? "update lot" : "insert lot",
        lotNumber: lot,
        expirationBefore: matchingExisting?.expiration ?? "(none)",
        expirationAfter: expirationIso,
        deletedLots: otherLots.map((l) => l.lot_number).join(", "),
        activeBefore: vaccine.active,
        activeAfter: true,
        vaccineId: vaccine.id,
        rawVaccineName: vaccine.name,
        effectiveName: vaccine.effectiveName,
        matchingLotId: matchingExisting?.id ?? null,
        deleteLotIds: otherLots.map((l) => l.id),
        newLot: matchingExisting
          ? null
          : { lot_number: lot, expiration: expirationIso, status: "active", vaccine_id: vaccine.id },
        updateLot: matchingExisting ? { id: matchingExisting.id, expiration: expirationIso } : null,
      });
    } else {
      // Listed brand, no lot: delete every existing lot, then active
      // reflects whether anything is left (see class doc comment) —
      // functionally always false here since we just deleted them all,
      // computed generically rather than hardcoded.
      const remainingAfterDelete = 0;
      plan.push({
        brand,
        name: vaccine.effectiveName,
        rename: rename ? `${vaccine.name} -> ${vaccine.effectiveName}` : "",
        action: "delete all lots (no lot listed)",
        lotNumber: "",
        expirationBefore: existingLots.map((l) => l.lot_number).join(", ") || "(none)",
        expirationAfter: "(none)",
        deletedLots: existingLots.map((l) => l.lot_number).join(", "),
        activeBefore: vaccine.active,
        activeAfter: remainingAfterDelete > 0,
        vaccineId: vaccine.id,
        rawVaccineName: vaccine.name,
        effectiveName: vaccine.effectiveName,
        matchingLotId: null,
        deleteLotIds: existingLots.map((l) => l.id),
        newLot: null,
        updateLot: null,
      });
    }
  }

  // --- Vaccine rows not matched by ANY brand at all: deactivate + delete lots ---
  for (const vaccine of rows) {
    if (matchedVaccineIds.has(vaccine.id)) continue;
    const existingLots = lotsByVaccineId.get(vaccine.id) ?? [];
    if (!vaccine.active && existingLots.length === 0) continue; // already inactive, nothing to do — omit from the table

    plan.push({
      brand: "(not in Will's list)",
      name: vaccine.effectiveName,
      rename: vaccine.name !== vaccine.effectiveName ? `${vaccine.name} -> ${vaccine.effectiveName}` : "",
      action: "not in list: deactivate + delete lots",
      lotNumber: "",
      expirationBefore: existingLots.map((l) => l.lot_number).join(", ") || "(none)",
      expirationAfter: "(none)",
      deletedLots: existingLots.map((l) => l.lot_number).join(", "),
      activeBefore: vaccine.active,
      activeAfter: false,
      vaccineId: vaccine.id,
      rawVaccineName: vaccine.name,
      effectiveName: vaccine.effectiveName,
      matchingLotId: null,
      deleteLotIds: existingLots.map((l) => l.id),
      newLot: null,
      updateLot: null,
    });
  }

  // --- Duplicate candidates: same (name, dose), currently 0 lots, 0 physician_rule references ---
  const byNameDose = new Map();
  for (const vaccine of rows) {
    const key = `${vaccine.effectiveName} ${vaccine.dose ?? ""}`;
    const list = byNameDose.get(key) ?? [];
    list.push(vaccine);
    byNameDose.set(key, list);
  }
  const duplicateCandidates = [];
  for (const group of byNameDose.values()) {
    if (group.length < 2) continue;
    for (const vaccine of group) {
      const hasLots = (lotsByVaccineId.get(vaccine.id) ?? []).length > 0;
      const hasRules = vaccineIdsWithRules.has(vaccine.id);
      if (!hasLots && !hasRules) {
        duplicateCandidates.push({
          name: vaccine.effectiveName,
          dose: vaccine.dose ?? "",
          shortCode: vaccine.short_code,
          vaccineId: vaccine.id,
        });
      }
    }
  }

  // --- Print the dry-run / pre-apply report ---
  console.log(`\nParsed ${listRows.length} brand rows from ${path.resolve(args.file)}.\n`);

  console.log(`=== Plan (${plan.length} vaccine row change(s)) ===`);
  if (plan.length === 0) {
    console.log("(no changes)");
  } else {
    printTable(plan, [
      { key: "brand", header: "Brand" },
      { key: "name", header: "Vaccine (after rename)" },
      { key: "rename", header: "Rename" },
      { key: "action", header: "Action" },
      { key: "lotNumber", header: "Lot #" },
      { key: "expirationBefore", header: "Before" },
      { key: "expirationAfter", header: "After (exp)" },
      { key: "deletedLots", header: "Lot(s) deleted" },
      { key: "activeBefore", header: "Active before" },
      { key: "activeAfter", header: "Active after" },
    ]);
  }

  console.log(`\n=== UNMAPPED brands (${unmappedBrands.length}) — no matching vaccine row, nothing touched ===`);
  if (unmappedBrands.length === 0) {
    console.log("(none)");
  } else {
    for (const brand of unmappedBrands) console.log(`  - ${brand}`);
  }

  console.log(`\n=== Duplicate vaccine rows — candidates for manual deletion (${duplicateCandidates.length}) ===`);
  console.log("(same name+dose as another row, 0 lots, 0 physician rules — NOT deleted by this script)");
  if (duplicateCandidates.length === 0) {
    console.log("(none)");
  } else {
    printTable(duplicateCandidates, [
      { key: "name", header: "Name" },
      { key: "dose", header: "Dose" },
      { key: "shortCode", header: "short_code" },
      { key: "vaccineId", header: "id" },
    ]);
  }

  if (!args.apply) {
    console.log("\nDry run only — no changes written. Re-run with --apply to write these changes.");
    process.exit(0);
  }

  // --- Apply for real ---
  console.log("\nApplying changes...");
  for (const change of plan) {
    if (change.rename) {
      const { error } = await supabase.from("vaccine").update({ name: change.effectiveName }).eq("id", change.vaccineId);
      if (error) throw new Error(`Renaming ${change.rawVaccineName}: ${error.message}`);
    }

    for (const lotId of change.deleteLotIds) {
      const { error } = await supabase.from("lot").delete().eq("id", lotId);
      if (error) throw new Error(`Deleting a lot for ${change.name}: ${error.message}`);
    }

    if (change.updateLot) {
      const { error } = await supabase.from("lot").update({ expiration: change.updateLot.expiration }).eq("id", change.updateLot.id);
      if (error) throw new Error(`Updating lot for ${change.name}: ${error.message}`);
    }
    if (change.newLot) {
      const { error } = await supabase.from("lot").insert(change.newLot);
      if (error) throw new Error(`Inserting lot for ${change.name}: ${error.message}`);
    }

    if (change.activeAfter !== change.activeBefore) {
      const { error } = await supabase.from("vaccine").update({ active: change.activeAfter }).eq("id", change.vaccineId);
      if (error) throw new Error(`Setting active=${change.activeAfter} for ${change.name}: ${error.message}`);
    }
  }

  console.log(`Applied ${plan.length} change(s).`);
  process.exit(0);
}

// Only run main() when executed directly (not when imported for unit
// tests — parseLotListTsv/parseExpirationToIso/nameMatchesAlias/
// computeEffectiveName/loadEnvFile are exported above for that).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
