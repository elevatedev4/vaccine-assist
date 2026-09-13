#!/usr/bin/env -S npx vite-node -c vitest.config.ts
// Runs the SAME logic as POST /api/administered/reprocess
// (app/api/administered/reprocess/route.ts) directly against the live
// Supabase project, via the shared lib/administered/reprocess.ts's
// reprocessAdministeredAttachments — re-reads every retained inbound
// attachment (lib/inbound-attachments.ts) that looks like a
// vaccination log and ingests it through the same parse -> match ->
// store path (lib/administered/ingest.ts). IDEMPOTENT (see that file's
// own header), so running this more than once, or after the route
// already ran, never double-counts a dose.
//
// Usage (from cloud/):
//   set -a; source .env.local; set +a
//   npx vite-node -c vitest.config.ts scripts/reprocess-administered.ts --dry-run
//   npx vite-node -c vitest.config.ts scripts/reprocess-administered.ts
//
// --dry-run only lists the retained attachments that look like a
// vaccination log (its header row matches isVaccinationLogHeaderLine) —
// it never calls ingestVaccinationLogMatrix, so nothing is written.
//
// -c vitest.config.ts is required — it aliases the "server-only" guard
// package to a no-op (see vitest.config.ts's comment) so the transitive
// import in lib/inbound-attachments.ts doesn't throw outside Next's
// build; vite-node otherwise runs the real TypeScript files directly
// (no compiled output, no added dependency — tsx/ts-node aren't in
// node_modules, but vite-node ships as a vitest dependency and is
// already installed).
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env
// (never imports lib/supabase/server.ts, which is gated to Next's
// server runtime).

import { createClient } from "@supabase/supabase-js";
import { reprocessAdministeredAttachments } from "@/lib/administered/reprocess";

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

  const result = await reprocessAdministeredAttachments(supabase, { dryRun });

  if (result.attachments.length === 0) {
    console.log("No retained attachments look like a vaccination log.");
  } else {
    console.log(
      `${dryRun ? "[dry run] " : ""}${result.attachments.length} vaccination-log attachment(s) found:\n`
    );
    for (const attachment of result.attachments) {
      console.log(`  ${attachment.receivedAt}  ${attachment.filename}  (${attachment.key})`);
    }
  }

  console.log("");
  console.log(
    JSON.stringify(
      {
        processed: result.processed,
        rows: result.rows,
        matched: result.matched,
        days: result.days,
        skipped: result.skipped,
      },
      null,
      2
    )
  );

  if (dryRun) {
    console.log("\n--dry-run: nothing ingested.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
