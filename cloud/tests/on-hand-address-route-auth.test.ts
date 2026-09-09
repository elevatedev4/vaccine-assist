import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/on-hand/address/route";

// Same pattern as tests/vaccines-route.test.ts: a request with no
// Authorization header short-circuits in requireAuthenticatedUser before
// touching Supabase, so this stays a fast, zero-mock test. See
// tests/on-hand-address-route.test.ts for the address/hasData logic with
// auth mocked.
describe("GET /api/on-hand/address auth gate", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/on-hand/address"));
    expect(response.status).toBe(401);
  });
});
