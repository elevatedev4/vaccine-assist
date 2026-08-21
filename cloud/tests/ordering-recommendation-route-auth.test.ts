import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/ordering/recommendation/route";

// Same shape as tests/vaccines-route.test.ts / tests/acuity-poll-route.test.ts:
// a request with no Authorization header short-circuits in
// requireAuthenticatedUser before it ever touches Supabase or Acuity, so
// this stays a fast, zero-env-dependency, UNMOCKED test. See
// tests/ordering-recommendation-route.test.ts for the route's own logic
// with auth mocked.
describe("/api/ordering/recommendation auth gate", () => {
  it("GET rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/ordering/recommendation"));
    expect(response.status).toBe(401);
  });
});
