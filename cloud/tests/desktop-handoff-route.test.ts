import { afterEach, describe, expect, it, vi } from "vitest";

// Same mocking pattern as tests/eligibility-for-age-route.test.ts: mock
// the Supabase server client factory so the route's OWN validation logic
// (missing/short tokens, getUser failure/success, unconfigured Supabase)
// can be exercised without a real Supabase project.
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { POST } from "@/app/api/auth/desktop-handoff/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { DESKTOP_HANDOFF_COOKIE_NAME } from "@/lib/desktop-handoff";

function postRequest(body: unknown) {
  return new Request("http://localhost/api/auth/desktop-handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockGetUser(result: { data: { user: unknown } ; error: unknown } | "throw") {
  if (result === "throw") {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase is not configured.");
    });
    return;
  }
  const getUser = vi.fn(async () => result);
  vi.mocked(getSupabaseServerClient).mockReturnValue({ auth: { getUser } } as never);
}

const VALID_ACCESS_TOKEN = "a".repeat(30);
const VALID_REFRESH_TOKEN = "r".repeat(20);

describe("POST /api/auth/desktop-handoff", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("400s on a missing access_token", async () => {
    const response = await POST(postRequest({ refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(400);
  });

  it("400s on a short/placeholder access_token", async () => {
    const response = await POST(postRequest({ access_token: "short", refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(400);
  });

  it("400s on a missing refresh_token", async () => {
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN }));
    expect(response.status).toBe(400);
  });

  it("400s on a short/placeholder refresh_token", async () => {
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: "x" }));
    expect(response.status).toBe(400);
  });

  it("400s on an invalid JSON body", async () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("401s when the access token doesn't validate", async () => {
    mockGetUser({ data: { user: null }, error: { message: "invalid" } });
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(401);
  });

  it("503s when Supabase isn't configured", async () => {
    mockGetUser("throw");
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(503);
  });

  it("redirects to / and sets the one-shot handoff cookie on success", async () => {
    mockGetUser({ data: { user: { id: "user-1" } }, error: null });
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${DESKTOP_HANDOFF_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).not.toContain("httponly");

    // Never leaks the raw token into the cookie unencoded/unescaped in a
    // way that would also leak it into a log line elsewhere — this just
    // confirms the cookie value is the encoded JSON, not something else.
    const cookieMatch = setCookie.match(new RegExp(`${DESKTOP_HANDOFF_COOKIE_NAME}=([^;]+)`));
    expect(cookieMatch).not.toBeNull();
    const decoded = JSON.parse(decodeURIComponent(cookieMatch![1]));
    expect(decoded).toEqual({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN });
  });
});
