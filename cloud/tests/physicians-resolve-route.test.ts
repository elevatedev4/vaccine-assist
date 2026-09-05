import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/physicians/resolve/route";

describe("/api/physicians/resolve auth gate", () => {
  it("rejects a request with no Authorization header", async () => {
    const response = await GET(
      new Request("http://localhost/api/physicians/resolve?vaccineId=v1&ageYears=10")
    );
    expect(response.status).toBe(401);
  });
});
