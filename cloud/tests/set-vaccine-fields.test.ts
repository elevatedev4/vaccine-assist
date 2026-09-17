import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile, nameMatchesSubstring } from "../scripts/set-vaccine-fields.mjs";

describe("nameMatchesSubstring", () => {
  it("matches case-insensitively", () => {
    expect(nameMatchesSubstring("mFLUSIVA 2026-27", "flusiva")).toBe(true);
    expect(nameMatchesSubstring("mFLUSIVA 2026-27", "MFLUSIVA")).toBe(true);
  });

  it("matches as a substring, not just a prefix", () => {
    expect(nameMatchesSubstring("Comirnaty 2026-27 12+", "12+")).toBe(true);
  });

  it("returns false when the substring isn't present", () => {
    expect(nameMatchesSubstring("Boostrix", "flusiva")).toBe(false);
  });
});

describe("loadEnvFile", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads KEY=VALUE lines into the target object", () => {
    dir = mkdtempSync(path.join(tmpdir(), "set-vaccine-fields-test-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=\"secret-key\"\n");

    const target = {};
    loadEnvFile(file, target);

    expect(target.SUPABASE_URL).toBe("https://example.supabase.co");
    expect(target.SUPABASE_SERVICE_ROLE_KEY).toBe("secret-key");
  });

  it("never overwrites a key already set on the target", () => {
    dir = mkdtempSync(path.join(tmpdir(), "set-vaccine-fields-test-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "SUPABASE_URL=https://from-file.supabase.co\n");

    const target = { SUPABASE_URL: "https://from-shell.supabase.co" };
    loadEnvFile(file, target);

    expect(target.SUPABASE_URL).toBe("https://from-shell.supabase.co");
  });

  it("does nothing when the file doesn't exist", () => {
    const target = {};
    loadEnvFile("/nonexistent/path/.env.local", target);
    expect(target).toEqual({});
  });

  it("skips blank lines and comments", () => {
    dir = mkdtempSync(path.join(tmpdir(), "set-vaccine-fields-test-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "# comment\n\nFOO=bar\n");

    const target = {};
    loadEnvFile(file, target);
    expect(target).toEqual({ FOO: "bar" });
  });
});
