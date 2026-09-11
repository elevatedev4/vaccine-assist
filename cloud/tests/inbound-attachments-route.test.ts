import { afterEach, describe, expect, it, vi } from "vitest";

// Same pattern as tests/vaccines-route-admin.test.ts: mock
// requireAuthenticatedUser to always succeed so the route's OWN logic
// (the inbound_attachment: prefix guard, the actual Supabase read,
// streaming the decoded bytes) can be exercised directly.
vi.mock("@/lib/auth", () => ({
  requireAuthenticatedUser: vi.fn(async () => ({ user: { id: "staff-1", email: "staff@example.com" } })),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { GET } from "@/app/api/inbound/attachments/[key]/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function authedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: "Bearer test-token" } });
}

// Security review fix (2026-09-11): app_setting is a SHARED table (also
// holds ordering.walk_in_pct, lots.bud_enabled_products, ...) — this
// route must refuse a non-prefixed key with a 404 BEFORE ever touching
// Supabase, so an authenticated caller can't read an unrelated setting
// row through the attachment-download endpoint. See also
// tests/inbound-attachments.test.ts's getInboundAttachmentByKey tests
// for the same guard at the helper layer.
describe("GET /api/inbound/attachments/[key]", () => {
  afterEach(() => {
    vi.mocked(getSupabaseServerClient).mockReset();
  });

  it("streams the decoded bytes for a properly-prefixed key", async () => {
    const attachment = {
      receivedAt: "2026-09-11T20:39:00.000Z",
      from: "owner@pioneerrx.example",
      subject: "AppExport",
      filename: "vaccination-log.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: 4,
      sha256: "abc",
      base64: Buffer.from("test").toString("base64"),
    };
    const maybeSingle = vi.fn(async () => ({ data: { value: attachment }, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const key = "inbound_attachment:2026-09-11T20:39:00.000Z:vaccination-log.xlsx";
    const response = await GET(authedRequest(`/api/inbound/attachments/${encodeURIComponent(key)}`), {
      params: Promise.resolve({ key: encodeURIComponent(key) }),
    });

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("key", key);
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.toString("utf-8")).toBe("test");
    expect(response.headers.get("Content-Disposition")).toContain("vaccination-log.xlsx");
  });

  it("returns 404 for a non-prefixed key WITHOUT ever calling Supabase", async () => {
    const response = await GET(authedRequest("/api/inbound/attachments/ordering.walk_in_pct"), {
      params: Promise.resolve({ key: "ordering.walk_in_pct" }),
    });

    expect(response.status).toBe(404);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-prefixed key even when URL-encoded (round-trips through decodeURIComponent before the check)", async () => {
    const response = await GET(authedRequest("/api/inbound/attachments/lots.bud_enabled_products"), {
      params: Promise.resolve({ key: encodeURIComponent("lots.bud_enabled_products") }),
    });

    expect(response.status).toBe(404);
    expect(getSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("returns 404 (not 503/500) for an unknown but properly-prefixed key", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseServerClient).mockReturnValue({ from } as never);

    const key = "inbound_attachment:2026-01-01T00:00:00.000Z:missing.xlsx";
    const response = await GET(authedRequest(`/api/inbound/attachments/${encodeURIComponent(key)}`), {
      params: Promise.resolve({ key: encodeURIComponent(key) }),
    });

    expect(response.status).toBe(404);
  });
});
