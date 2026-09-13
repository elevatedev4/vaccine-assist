#!/usr/bin/env -S npx vite-node -c vitest.config.ts
// Runs the SAME logic as the /entry-values page's "Reset all directions
// to standard" button — lib/entry-defaults.ts's planFillDefaults with
// { overwriteDirections: true } — directly against the live Supabase
// `vaccine` table, for the times Will asks for a directions backfill
// without wanting to click through the UI ("I don't want to push
// buttons, just fix the data I ask for.", 2026-09-12).
//
// doseCount/doseNumber are computed via lib/entry-values.ts's
// buildEntryValueRows, which (after this same fix) uses
// lib/dose-family.ts's doseCountByVaccineId — so a product whose dose
// rows carry mismatched NDCs (e.g. Shingrix) gets the correct combined
// dose count here too, not just in the browser.
//
// QUANTITY IS NEVER TOUCHED BY THIS SCRIPT. planFillDefaults can also
// emit a `quantity` patch (same as the button, when a row's quantity is
// blank and a default exists) — this script deliberately drops any
// `quantity` field from every patch before printing/applying it, so it
// only ever writes `directions`, regardless of what the shared planner
// would otherwise do. That's a narrower guarantee than the button
// itself makes, on purpose (Will: "just fix the data I ask for").
//
// Usage (from cloud/):
//   set -a; source .env.local; set +a
//   npx vite-node -c vitest.config.ts scripts/backfill-entry-directions.ts --dry-run
//   npx vite-node -c vitest.config.ts scripts/backfill-entry-directions.ts
//
// -c vitest.config.ts is required — it aliases the "server-only" guard
// package to a no-op (see vitest.config.ts's comment) so lib/entry-
// values.ts's transitive imports don't throw outside Next's build; vite-
// node otherwise runs the real TypeScript files directly (no compiled
// output, no added dependency — tsx/ts-node aren't in node_modules, but
// vite-node ships as a vitest dependency and is already installed).
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env
// (never imports lib/supabase/server.ts, which is gated to Next's
// server runtime). --dry-run prints the before/after table without
// writing anything. Idempotent: a row already at its computed default
// produces no patch on a second run.

import { createClient } from "@supabase/supabase-js";
import { buildEntryValueRows, type EntryValueVaccine } from "@/lib/entry-values";
import { planFillDefaults, type FillDefaultsRow } from "@/lib/entry-defaults";

type VaccineRow = {
  id: string;
  name: string;
  ndc: string | null;
  dose: string | null;
  short_code: string | null;
  quantity: string | null;
  directions: string | null;
  active: boolean;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`Missing required env var ${name} (expected .env.local sourced into the shell — see this file's header).`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("vaccine")
    .select("id, name, ndc, dose, short_code, quantity, directions, active");
  if (error) {
    console.error("Failed to load vaccine rows:", error.message ?? error);
    process.exit(1);
  }

  const vaccines = (data ?? []) as VaccineRow[];
  const entryVaccines: EntryValueVaccine[] = vaccines.map((v) => ({
    id: v.id,
    name: v.name,
    ndc: v.ndc,
    active: v.active,
    dose: v.dose,
    short_code: v.short_code,
    quantity: v.quantity,
    directions: v.directions,
  }));

  const rows = buildEntryValueRows(entryVaccines);
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const plannerRows: FillDefaultsRow[] = rows.map((row) => ({
    id: row.id,
    shortCode: row.shortCode,
    quantity: row.quantity,
    directions: row.directions,
    doseNumber: row.doseNumber,
    doseCount: row.doseCount,
  }));

  const patches = planFillDefaults(plannerRows, { overwriteDirections: true })
    // Quantity is never touched by this script — see file header.
    .filter((patch) => patch.directions !== undefined)
    .map((patch) => ({ id: patch.id, directions: patch.directions as string }));

  if (patches.length === 0) {
    console.log("Nothing to change — every row's directions already match the computed default.");
    return;
  }

  console.log(`${dryRun ? "[dry run] " : ""}${patches.length} row(s) to update:\n`);
  console.log(
    ["Product", "Dose", "Old directions", "New directions"].join(" | ")
  );
  for (const patch of patches) {
    const row = rowById.get(patch.id);
    const product = row?.displayName ?? patch.id;
    const dose = row ? String(row.doseNumber) : "?";
    const oldDirections = row?.directions && row.directions.trim() ? row.directions : "(blank)";
    console.log(`${product} | ${dose} | ${oldDirections} | ${patch.directions}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    return;
  }

  let updated = 0;
  for (const patch of patches) {
    const { error: updateError } = await supabase
      .from("vaccine")
      .update({ directions: patch.directions })
      .eq("id", patch.id);
    if (updateError) {
      const row = rowById.get(patch.id);
      console.error(`Failed to update ${row?.displayName ?? patch.id} (${patch.id}):`, updateError.message ?? updateError);
      continue;
    }
    updated += 1;
  }

  console.log(`\nUpdated ${updated}/${patches.length} row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
