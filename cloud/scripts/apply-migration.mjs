#!/usr/bin/env node
// Applies a single supabase/migrations/*.sql file directly against
// Postgres, so Will can run a brand-new migration (e.g. 0013_session_management.sql
// for V-sessions) with one terminal paste instead of going through the
// Supabase SQL editor by hand.
//
// Talks to Postgres directly via DATABASE_URL (the project's direct
// connection string, NOT the Supabase URL/service-role key the app uses
// for PostgREST) — needed here because this migration creates SQL
// functions, which PostgREST/supabase-js has no path to do.
//
// NEVER run this against the real database from an agent session — same
// posture as scripts/apply-lot-list.mjs's --apply flag: Will runs it
// himself, from his own terminal, after reviewing the migration file.
//
// Usage (from cloud/):
//   node scripts/apply-migration.mjs ../supabase/migrations/0013_session_management.sql
//
// Requires DATABASE_URL in cloud/.env.local — the Supabase project's
// direct Postgres connection string (Project Settings > Database >
// Connection string > URI). Any `sslmode=...` query param on that
// string is stripped before connecting; TLS is always enabled here via
// an explicit `ssl` option instead (Supabase's pooled/direct connection
// strings commonly carry `sslmode=require`, which the `pg` package
// doesn't understand as a connection-string param the way libpq does).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const { Client } = pg;

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const cloudDir = path.resolve(scriptsDir, "..");

dotenv.config({ path: path.join(cloudDir, ".env.local") });

function stripSslMode(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  return url.toString();
}

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    console.error("Usage: node scripts/apply-migration.mjs <path-to-migration.sql>");
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (expected in cloud/.env.local).");
    process.exitCode = 1;
    return;
  }

  const resolvedMigrationPath = path.resolve(process.cwd(), migrationPath);
  const sql = await readFile(resolvedMigrationPath, "utf8");

  const client = new Client({
    connectionString: stripSslMode(databaseUrl),
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`applied ${resolvedMigrationPath}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
