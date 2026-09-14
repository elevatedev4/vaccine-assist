import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/sessions/route";
import { DELETE } from "@/app/api/sessions/[id]/route";
import { POST } from "@/app/api/sessions/sign-out-everywhere/route";

// Same pattern as tests/on-hand-latest-route-auth.test.ts: a request with
// no Authorization header short-circuits in requireAuthenticatedUser
// before touching Supabase — a fast, zero-mock test for each route.
describe("Sessions routes auth gate", () => {
  it("GET /api/sessions rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/sessions"));
    expect(response.status).toBe(401);
  });

  it("DELETE /api/sessions/[id] rejects a request with no Authorization header", async () => {
    const response = await DELETE(new Request("http://localhost/api/sessions/sess-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "sess-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("POST /api/sessions/sign-out-everywhere rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/sign-out-everywhere", { method: "POST" })
    );
    expect(response.status).toBe(401);
  });
});
