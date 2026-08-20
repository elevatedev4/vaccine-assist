import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/vaccines/route";
import { PATCH } from "@/app/api/vaccines/[id]/route";

// Only exercises the auth gate, not the route logic — a request with no
// Authorization header short-circuits in requireAuthenticatedUser before
// it ever touches Supabase (see lib/auth.ts), so this stays a fast,
// zero-env-dependency test. See tests/vaccines-route-admin.test.ts for
// the includeInactive/hasActiveLot/PATCH-body logic with auth mocked.
describe("/api/vaccines auth gate", () => {
  it("GET (default) rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/vaccines"));
    expect(response.status).toBe(401);
  });

  it("GET ?includeInactive=true rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/vaccines?includeInactive=true"));
    expect(response.status).toBe(401);
  });

  it("PATCH rejects a request with no Authorization header", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/vaccines/some-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      }),
      { params: Promise.resolve({ id: "some-id" }) }
    );
    expect(response.status).toBe(401);
  });
});
