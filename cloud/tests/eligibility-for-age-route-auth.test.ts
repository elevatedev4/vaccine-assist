import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/eligibility/for-age/route";

// Only exercises the auth gate, not the route logic — a request with no
// Authorization header short-circuits in requireAuthenticatedUser before
// it ever touches Supabase (see lib/auth.ts), so this stays a fast,
// zero-env-dependency test. See tests/eligibility-for-age-route.test.ts
// for the age-validation/eligibility-filtering logic with auth mocked —
// same split tests/vaccines-route.test.ts / tests/vaccines-route-admin.test.ts uses.
describe("/api/eligibility/for-age auth gate", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/eligibility/for-age?age=10"));
    expect(response.status).toBe(401);
  });
});
