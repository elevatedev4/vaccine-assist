import { afterEach, describe, expect, it, vi } from "vitest";

// Same mocking pattern as tests/eligibility-for-age-route.test.ts: mock
// the Supabase server client factory so the route's OWN validation logic
// (CSRF headers, missing/short tokens, getUser/setSession failure or
// mismatch, unconfigured Supabase) can be exercised without a real
// Supabase project.
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { POST, isTrustedDesktopRequest } from "@/app/api/auth/desktop-handoff/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { DESKTOP_HANDOFF_COOKIE_NAME } from "@/lib/desktop-handoff";

const VALID_ACCESS_TOKEN = "a".repeat(30);
const VALID_REFRESH_TOKEN = "r".repeat(20);

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/desktop-handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vaccine-Assist-Desktop": "1", ...headers },
    body: JSON.stringify(body),
  });
}

/** Same-user getUser + setSession mock for the success path. */
function mockValidSession(userId = "user-1") {
  const getUser = vi.fn(async () => ({ data: { user: { id: userId } }, error: null }));
  const setSession = vi.fn(async () => ({ data: { session: { user: { id: userId } } }, error: null }));
  vi.mocked(getSupabaseServerClient).mockReturnValue({ auth: { getUser, setSession } } as never);
  return { getUser, setSession };
}

function mockGetUserResult(result: { data: { user: unknown }; error: unknown } | "throw") {
  if (result === "throw") {
    vi.mocked(getSupabaseServerClient).mockImplementation(() => {
      throw new Error("Supabase is not configured.");
    });
    return;
  }
  const getUser = vi.fn(async () => result);
  const setSession = vi.fn(async () => ({ data: { session: null }, error: null }));
  vi.mocked(getSupabaseServerClient).mockReturnValue({ auth: { getUser, setSession } } as never);
}

describe("isTrustedDesktopRequest", () => {
  it("rejects a request missing the desktop header", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(isTrustedDesktopRequest(request)).toBe(false);
  });

  it("rejects a request whose Origin doesn't match the request's own origin", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vaccine-Assist-Desktop": "1",
        Origin: "https://attacker.example",
      },
    });
    expect(isTrustedDesktopRequest(request)).toBe(false);
  });

  it("rejects a cross-site Sec-Fetch-Site value", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vaccine-Assist-Desktop": "1",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(isTrustedDesktopRequest(request)).toBe(false);
  });

  it("rejects a non-JSON content type", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Vaccine-Assist-Desktop": "1" },
    });
    expect(isTrustedDesktopRequest(request)).toBe(false);
  });

  it("accepts the desktop header with a matching Origin and same-origin Sec-Fetch-Site", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vaccine-Assist-Desktop": "1",
        Origin: "http://localhost",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(isTrustedDesktopRequest(request)).toBe(true);
  });

  it("accepts the desktop header when Origin/Sec-Fetch-Site are simply absent", () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vaccine-Assist-Desktop": "1" },
    });
    expect(isTrustedDesktopRequest(request)).toBe(true);
  });
});

describe("POST /api/auth/desktop-handoff", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("403s when the desktop-only header is missing (CSRF)", async () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it("403s on a cross-site Origin even with a valid body", async () => {
    const request = new Request("http://localhost/api/auth/desktop-handoff", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vaccine-Assist-Desktop": "1",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
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
      headers: { "Content-Type": "application/json", "X-Vaccine-Assist-Desktop": "1" },
      body: "not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("401s when the access token doesn't validate", async () => {
    mockGetUserResult({ data: { user: null }, error: { message: "invalid" } });
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(401);
  });

  it("401s when the refresh_token belongs to a different user than the access_token", async () => {
    const getUser = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
    const setSession = vi.fn(async () => ({ data: { session: { user: { id: "user-2" } } }, error: null }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ auth: { getUser, setSession } } as never);

    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(401);
  });

  it("401s when setSession itself errors", async () => {
    const getUser = vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null }));
    const setSession = vi.fn(async () => ({ data: { session: null }, error: { message: "invalid refresh token" } }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ auth: { getUser, setSession } } as never);

    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(401);
  });

  it("503s when Supabase isn't configured", async () => {
    mockGetUserResult("throw");
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));
    expect(response.status).toBe(503);
  });

  it("redirects to / and sets a Secure, one-shot handoff cookie on success", async () => {
    mockValidSession();
    const response = await POST(postRequest({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/");

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${DESKTOP_HANDOFF_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).not.toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("secure");

    // Never leaks the raw token into the cookie unencoded/unescaped in a
    // way that would also leak it into a log line elsewhere — this just
    // confirms the cookie value is the encoded JSON, not something else.
    const cookieMatch = setCookie.match(new RegExp(`${DESKTOP_HANDOFF_COOKIE_NAME}=([^;]+)`));
    expect(cookieMatch).not.toBeNull();
    const decoded = JSON.parse(decodeURIComponent(cookieMatch![1]));
    expect(decoded).toEqual({ access_token: VALID_ACCESS_TOKEN, refresh_token: VALID_REFRESH_TOKEN });
  });
});
