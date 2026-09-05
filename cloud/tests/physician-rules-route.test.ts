import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/physician-rules/route";
import { PATCH, DELETE } from "@/app/api/physician-rules/[id]/route";

describe("/api/physician-rules auth gate", () => {
  it("GET rejects a request with no Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/physician-rules"));
    expect(response.status).toBe(401);
  });

  it("POST rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/physician-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ physician_id: "p1" }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("PATCH rejects a request with no Authorization header", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/physician-rules/some-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: 1 }),
      }),
      { params: Promise.resolve({ id: "some-id" }) }
    );
    expect(response.status).toBe(401);
  });

  it("DELETE rejects a request with no Authorization header", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/physician-rules/some-id", { method: "DELETE" }),
      { params: Promise.resolve({ id: "some-id" }) }
    );
    expect(response.status).toBe(401);
  });
});
