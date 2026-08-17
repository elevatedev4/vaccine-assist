import { beforeEach, describe, expect, it, vi } from "vitest";

// tests/acuity-poll-route.test.ts covers the real auth gate (401 with no
// Authorization header). This file mocks requireAuthenticatedUser to
// always succeed so the route's OWN validation logic (date format,
// start>end, the 31-day range cap, and the unconfigured-credentials JSON
// shape) can be exercised directly — those all run after the auth check,
// and there's no Supabase available in this test environment to make a
// real auth call succeed (see tests/acuity-credentials.test.ts).
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

import { GET } from "@/app/api/acuity/poll/route";

const ACUITY_ENV_KEYS = ["ACUITY_USER_ID", "ACUITY_API_KEY"] as const;

function pollRequest(query: string) {
  return new Request(`http://localhost/api/acuity/poll${query}`, {
    headers: { Authorization: "Bearer test-token" },
  });
}

describe("GET /api/acuity/poll — validation", () => {
  beforeEach(() => {
    for (const key of ACUITY_ENV_KEYS) delete process.env[key];
  });

  it("rejects a malformed date", async () => {
    const response = await GET(pollRequest("?start=not-a-date&end=2026-08-24"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/YYYY-MM-DD/);
  });

  it("rejects start after end", async () => {
    const response = await GET(pollRequest("?start=2026-08-24&end=2026-08-17"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/start must not be after end/i);
  });

  it("rejects a range spanning more than 31 days", async () => {
    const response = await GET(pollRequest("?start=2026-01-01&end=2026-12-31"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/31 days/i);
  });

  it("rejects a wide-open unbounded range (e.g. year 0000 to year 2999)", async () => {
    const response = await GET(pollRequest("?start=0000-01-01&end=2999-12-31"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/31 days/i);
  });

  it("accepts a range exactly at the 31-day cap", async () => {
    // 2026-08-01..2026-08-31 inclusive = 31 days.
    const response = await GET(pollRequest("?start=2026-08-01&end=2026-08-31"));
    expect(response.status).toBe(200);
  });

  it("returns the unconfigured-credentials JSON shape when no Acuity credentials exist", async () => {
    const response = await GET(pollRequest("?start=2026-08-17&end=2026-08-18"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      configured: false,
      message: expect.stringMatching(/not configured/i),
      settingsUrl: "/settings",
      range: { start: "2026-08-17", end: "2026-08-18" },
      counts: [],
      possiblyTruncated: false,
      cacheHit: false,
      asOf: null,
    });
  });
});
