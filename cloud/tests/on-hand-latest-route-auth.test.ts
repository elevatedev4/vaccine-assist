import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/on-hand/latest/route";

// Same pattern as tests/on-hand-address-route-auth.test.ts: a request
// with no Authorization header short-circuits in requireAuthenticatedUser
// before touching Supabase — a fast, zero-mock test. See
// tests/on-hand-latest-route.test.ts for the batch-selection logic with
// auth mocked.
describe("GET /api/on-hand/latest auth gate", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/on-hand/latest"));
    expect(response.status).toBe(401);
  });
});
