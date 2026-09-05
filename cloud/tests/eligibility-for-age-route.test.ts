import { afterEach, describe, expect, it, vi } from "vitest";

// Same pattern as tests/vaccines-route-admin.test.ts: mock
// requireAuthenticatedUser to always succeed so the route's OWN logic
// (age validation, per-vaccine eligibility evaluation, blocked filtering)
// can be exercised directly. The real 401-with-no-header auth gate is
// covered separately in tests/eligibility-for-age-route-auth.test.ts
// (unmocked, so it hits the real check) — same split
// tests/vaccines-route.test.ts / tests/vaccines-route-admin.test.ts uses.
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/eligibility/for-age/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: "Bearer test-token" },
  });
}

function mockSupabase(vaccines: unknown[], rules: unknown[]) {
  const order = vi.fn(async () => ({ data: vaccines, error: null }));
  const eq = vi.fn(() => ({ order }));
  const vaccineSelect = vi.fn(() => ({ eq }));

  const inFn = vi.fn(async () => ({ data: rules, error: null }));
  const ruleSelect = vi.fn(() => ({ in: inFn }));

  const from = vi.fn((table: string) => {
    if (table === "vaccine") return { select: vaccineSelect };
    if (table === "eligibility_rule") return { select: ruleSelect };
    throw new Error(`unexpected table ${table}`);
  });

  vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);
  return { from, inFn };
}

describe("GET /api/eligibility/for-age", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("400s when age is missing or not a number", async () => {
    const missing = await GET(authedRequest("/api/eligibility/for-age"));
    expect(missing.status).toBe(400);

    const notANumber = await GET(authedRequest("/api/eligibility/for-age?age=abc"));
    expect(notANumber.status).toBe(400);
  });

  it("excludes a vaccine whose rule blocks this age, includes allowed/warning ones with eligibility attached", async () => {
    const vaccines = [
      { id: "v-mmr", name: "MMR-II", active: true, dose: "1" },
      { id: "v-gardasil", name: "Gardasil", active: true, dose: "1" },
    ];
    const rules = [
      // MMR-II: 3+ with a pregnancy warning — age 60 should be a "warning", not blocked.
      { vaccine_id: "v-mmr", min_age: 3, max_age: null, condition_note: null, pregnancy_warning: true, priority: 0 },
      // Gardasil: 9-45 — age 60 is blocked (above max_age).
      { vaccine_id: "v-gardasil", min_age: 9, max_age: 45, condition_note: null, pregnancy_warning: false, priority: 0 },
    ];
    mockSupabase(vaccines, rules);

    const response = await GET(authedRequest("/api/eligibility/for-age?age=60"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.vaccines).toHaveLength(1);
    expect(body.vaccines[0].id).toBe("v-mmr");
    expect(body.vaccines[0].eligibility.status).toBe("warning");
  });

  it("returns an empty list (not an error) when no active vaccine is eligible for this age", async () => {
    const vaccines = [{ id: "v-gardasil", name: "Gardasil", active: true, dose: "1" }];
    const rules = [
      { vaccine_id: "v-gardasil", min_age: 9, max_age: 45, condition_note: null, pregnancy_warning: false, priority: 0 },
    ];
    mockSupabase(vaccines, rules);

    const response = await GET(authedRequest("/api/eligibility/for-age?age=2"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccines).toEqual([]);
  });

  it("treats a vaccine with no eligibility rule on file as a warning (allowed, not blocked) — same convention as evaluate/route.ts", async () => {
    const vaccines = [{ id: "v-new", name: "New Vaccine", active: true, dose: "1" }];
    mockSupabase(vaccines, []);

    const response = await GET(authedRequest("/api/eligibility/for-age?age=40"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccines).toHaveLength(1);
    expect(body.vaccines[0].eligibility.status).toBe("warning");
  });

  it("never queries eligibility_rule when there are no active vaccines at all", async () => {
    const { from } = mockSupabase([], []);

    const response = await GET(authedRequest("/api/eligibility/for-age?age=10"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vaccines).toEqual([]);
    expect(from).not.toHaveBeenCalledWith("eligibility_rule");
  });
});
