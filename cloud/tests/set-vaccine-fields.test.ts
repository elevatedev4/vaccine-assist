import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findShortCodeConflict,
  isValidShortCode,
  loadEnvFile,
  nameMatchesSubstring,
} from "../scripts/set-vaccine-fields.mjs";

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

describe("isValidShortCode (V-T50: --short-code arg)", () => {
  it("accepts lowercase letters and digits", () => {
    expect(isValidShortCode("mflusiva")).toBe(true);
    expect(isValidShortCode("shingrix1")).toBe(true);
    expect(isValidShortCode("comirnaty12")).toBe(true);
  });

  it("rejects uppercase, spaces, punctuation, and empty strings", () => {
    expect(isValidShortCode("mFLUSIVA")).toBe(false);
    expect(isValidShortCode("m flusiva")).toBe(false);
    expect(isValidShortCode("mflusiva-2026")).toBe(false);
    expect(isValidShortCode("")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidShortCode(null)).toBe(false);
    expect(isValidShortCode(undefined)).toBe(false);
  });
});

describe("findShortCodeConflict (V-T50: --short-code uniqueness check)", () => {
  const vaccines = [
    { id: "v1", name: "mFLUSIVA 2026-27", short_code: "unmapped123" },
    { id: "v2", name: "Fluad", short_code: "fluad" },
    { id: "v3", name: "No Code Yet", short_code: null },
  ];

  it("finds another vaccine already using the requested short_code, case-insensitively", () => {
    expect(findShortCodeConflict(vaccines, "fluad", "v1")).toEqual(vaccines[1]);
    expect(findShortCodeConflict(vaccines, "FLUAD", "v1")).toEqual(vaccines[1]);
  });

  it("returns null when the code is free", () => {
    expect(findShortCodeConflict(vaccines, "mflusiva", "v1")).toBeNull();
  });

  it("excludes the vaccine's own row (re-applying its own current code is not a conflict)", () => {
    expect(findShortCodeConflict(vaccines, "unmapped123", "v1")).toBeNull();
  });

  it("never matches against a null short_code", () => {
    expect(findShortCodeConflict(vaccines, "somecode", "v2")).toBeNull();
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
