import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/settings/acuity/route";
import { POST as testConnection } from "@/app/api/settings/acuity/test/route";

// Same shape as tests/acuity-poll-route.test.ts: only the auth gate is
// exercised here (no Authorization header short-circuits in
// requireAuthenticatedUser before any Supabase/Acuity call), keeping this
// fast and zero-env-dependency.
describe("/api/settings/acuity", () => {
  it("GET rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/settings/acuity"));
    expect(response.status).toBe(401);
  });

  it("POST rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/settings/acuity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acuityUserId: "123", acuityApiKey: "secret" }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("test-connection route rejects a request with no Authorization header", async () => {
    const response = await testConnection(
      new Request("http://localhost/api/settings/acuity/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(401);
  });
});
