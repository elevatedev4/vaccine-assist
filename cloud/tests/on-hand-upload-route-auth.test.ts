import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/on-hand/upload/route";

describe("POST /api/on-hand/upload auth gate", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await POST(
      new Request("http://localhost/api/on-hand/upload", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "Flu Quad 2025-26, 10",
      })
    );
    expect(response.status).toBe(401);
  });
});
