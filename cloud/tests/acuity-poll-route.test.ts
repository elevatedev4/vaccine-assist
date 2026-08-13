import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/acuity/poll/route";

// Only exercises the auth gate, not the poll logic — a request with no
// Authorization header short-circuits in requireAuthenticatedUser before
// it ever touches Supabase (see lib/auth.ts), so this stays a fast, zero
// -env-dependency test. See tests/auth.test.ts for the header-parsing
// unit tests and vitest.config.ts for the "server-only" alias this route
// import needs to load under plain vitest.
describe("GET /api/acuity/poll", () => {
  it("rejects a request with no Authorization header", async () => {
    const request = new Request("http://localhost/api/acuity/poll");
    const response = await GET(request);
    expect(response.status).toBe(401);
  });
});
