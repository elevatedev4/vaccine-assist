import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/physicians/route";
import { PATCH, DELETE } from "@/app/api/physicians/[id]/route";

// Only exercises the auth gate — see tests/physicians-route-admin.test.ts
// for the actual CRUD logic with auth mocked. Same split as
// tests/vaccines-route.test.ts / tests/vaccines-route-admin.test.ts.
describe("/api/physicians auth gate", () => {
  it("GET rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/physicians"));
    expect(response.status).toBe(401);
  });

  it("POST rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/physicians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane", alternate_id: "ALT1" }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("PATCH rejects a request with no Authorization header", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/physicians/some-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "Doe, Jane" }),
      }),
      { params: Promise.resolve({ id: "some-id" }) }
    );
    expect(response.status).toBe(401);
  });

  it("DELETE rejects a request with no Authorization header", async () => {
    const response = await DELETE(new Request("http://localhost/api/physicians/some-id", { method: "DELETE" }), {
      params: Promise.resolve({ id: "some-id" }),
    });
    expect(response.status).toBe(401);
  });
});
