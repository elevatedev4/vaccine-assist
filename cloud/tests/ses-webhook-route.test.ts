import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/sns-signature", () => ({
  verifySnsSignature: vi.fn(async () => true),
  isAllowedSnsHost: vi.fn((url: string) => /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com/i.test(url)),
}));

import { POST } from "@/app/api/webhooks/ses/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { verifySnsSignature } from "@/lib/sns-signature";

const CATALOG = [
  { id: "v-flu", name: "Flu Quad 2025-26", short_code: "fluquad" },
  { id: "v-mmr", name: "MMR-II", short_code: "mmrii" },
];

// Minimal stand-in matching exactly how the route queries: vaccine ->
// select() resolves directly (no further chaining needed since the route
// awaits the select() result), on_hand_count -> insert(rows).
function fakeSupabaseClient(insert: (rows: unknown[]) => Promise<{ error: unknown }> = vi.fn(async () => ({ error: null }))) {
  return {
    from: (table: string) => {
      if (table === "vaccine") {
        return { select: async () => ({ data: CATALOG, error: null }) };
      }
      if (table === "on_hand_count") {
        return { insert };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}, url = "http://localhost/api/webhooks/ses") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function textRequest(text: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...headers },
    body: text,
  });
}

const CRLF = "\r\n";
const RAW_MIME = ["Content-Type: text/plain; charset=UTF-8", "", "Flu Quad 2025-26, 10" + CRLF + "MMR, 15"].join(CRLF);

function snsNotificationBody(overrides: Record<string, unknown> = {}, sesMessageOverrides: Record<string, unknown> = {}) {
  const sesMessage = {
    notificationType: "Received",
    mail: { timestamp: "2026-09-05T12:00:00.000Z" },
    content: Buffer.from(RAW_MIME, "utf-8").toString("base64"),
    ...sesMessageOverrides,
  };
  return {
    Type: "Notification",
    MessageId: "msg-1",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:vaccines-onhand",
    Message: JSON.stringify(sesMessage),
    Timestamp: "2026-09-05T12:00:01.000Z",
    SignatureVersion: "1",
    Signature: "fake-signature",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    ...overrides,
  };
}

function snsSubscriptionConfirmationBody(overrides: Record<string, unknown> = {}) {
  return {
    Type: "SubscriptionConfirmation",
    MessageId: "msg-sub-1",
    Token: "token-abc",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:vaccines-onhand",
    Message: "You have chosen to subscribe to the topic.",
    SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-abc",
    Timestamp: "2026-09-05T12:00:01.000Z",
    SignatureVersion: "1",
    Signature: "fake-signature",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    ...overrides,
  };
}

describe("POST /api/webhooks/ses", () => {
  beforeEach(() => {
    delete process.env.SES_WEBHOOK_SECRET;
    delete process.env.SES_SNS_TOPIC_ARN;
    vi.mocked(verifySnsSignature).mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.SES_WEBHOOK_SECRET;
    delete process.env.SES_SNS_TOPIC_ARN;
    vi.mocked(getSupabaseServerClient).mockReset();
    vi.mocked(verifySnsSignature).mockReset();
    vi.unstubAllGlobals();
  });

  describe("legacy simple contract (unchanged)", () => {
    it("rejects a request with the wrong secret when SES_WEBHOOK_SECRET is set", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }, { "x-ses-webhook-secret": "wrong" }));
      expect(response.status).toBe(401);
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    });

    it("accepts a request with the correct secret", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

      const response = await POST(
        jsonRequest({ text: "Flu Quad 2025-26, 10" }, { "x-ses-webhook-secret": "correct-secret" })
      );
      expect(response.status).toBe(200);
    });

    it("accepts the correct secret via ?secret= query param", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

      const response = await POST(
        jsonRequest({ text: "Flu Quad 2025-26, 10" }, {}, "http://localhost/api/webhooks/ses?secret=correct-secret")
      );
      expect(response.status).toBe(200);
    });

    it("rejects a wrong secret passed via query param", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      const response = await POST(
        jsonRequest({ text: "Flu Quad 2025-26, 10" }, {}, "http://localhost/api/webhooks/ses?secret=wrong")
      );
      expect(response.status).toBe(401);
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    });

    it("parses a JSON { text } body and returns a linesTotal/matchedCount/unmatchedCount summary", async () => {
      const insert = vi.fn(async () => ({ error: null }));
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient(insert) as never);

      const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10\nUnknown Vaccine, 3" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 2, matchedCount: 1, unmatchedCount: 1 });
      expect(insert).toHaveBeenCalledWith([
        { raw_line: "Flu Quad 2025-26, 10", vaccine_name_raw: "Flu Quad 2025-26", quantity: 10, vaccine_id: "v-flu", matched: true },
        { raw_line: "Unknown Vaccine, 3", vaccine_name_raw: "Unknown Vaccine", quantity: 3, vaccine_id: null, matched: false },
      ]);
    });

    it("accepts the { body } alias key in JSON", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

      const response = await POST(jsonRequest({ body: "MMR, 15" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 1, matchedCount: 1, unmatchedCount: 0 });
    });

    it("treats a text/plain body as the content directly", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

      const response = await POST(textRequest("Flu Quad 2025-26, 10\nMMR, 15"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 2, matchedCount: 2, unmatchedCount: 0 });
    });

    it("returns a zeroed summary without touching Supabase for empty content", async () => {
      const response = await POST(jsonRequest({ text: "" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 0, matchedCount: 0, unmatchedCount: 0 });
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    });

    it("returns 503 instead of throwing when Supabase is unconfigured", async () => {
      vi.mocked(getSupabaseServerClient).mockImplementation(() => {
        throw new Error("Supabase server client requested but not configured.");
      });

      const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }));
      expect(response.status).toBe(503);
    });

    it("returns 500 when the insert fails", async () => {
      vi.mocked(getSupabaseServerClient).mockReturnValue(
        fakeSupabaseClient(vi.fn(async () => ({ error: new Error("boom") }))) as never
      );

      const response = await POST(jsonRequest({ text: "Flu Quad 2025-26, 10" }));
      expect(response.status).toBe(500);
    });
  });

  describe("SNS SubscriptionConfirmation", () => {
    it("confirms by fetching SubscribeURL when topic ARN matches", async () => {
      process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:vaccines-onhand";
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(
        jsonRequest(snsSubscriptionConfirmationBody(), { "x-amz-sns-message-type": "SubscriptionConfirmation" })
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=token-abc"
      );
    });

    it("rejects a topic ARN mismatch without fetching SubscribeURL", async () => {
      process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:vaccines-onhand";
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(
        jsonRequest(
          snsSubscriptionConfirmationBody({ TopicArn: "arn:aws:sns:us-east-1:123456789012:some-other-topic" }),
          { "x-amz-sns-message-type": "SubscriptionConfirmation" }
        )
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts (with a bootstrapping warning) when SES_SNS_TOPIC_ARN is unset", async () => {
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await POST(
        jsonRequest(snsSubscriptionConfirmationBody(), { "x-amz-sns-message-type": "SubscriptionConfirmation" })
      );

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("SES_SNS_TOPIC_ARN is not set"));
      warnSpy.mockRestore();
    });

    it("rejects when the SNS message signature fails verification", async () => {
      process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:vaccines-onhand";
      vi.mocked(verifySnsSignature).mockResolvedValue(false);
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(
        jsonRequest(snsSubscriptionConfirmationBody(), { "x-amz-sns-message-type": "SubscriptionConfirmation" })
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("SNS Notification (SES received-email envelope)", () => {
    it("extracts the MIME text and ingests it through the same on-hand parser path", async () => {
      process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:vaccines-onhand";
      const insert = vi.fn(async () => ({ error: null }));
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient(insert) as never);

      const response = await POST(
        jsonRequest(snsNotificationBody(), { "x-amz-sns-message-type": "Notification" })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 2, matchedCount: 2, unmatchedCount: 0 });
      expect(insert).toHaveBeenCalledWith([
        { raw_line: "Flu Quad 2025-26, 10", vaccine_name_raw: "Flu Quad 2025-26", quantity: 10, vaccine_id: "v-flu", matched: true },
        { raw_line: "MMR, 15", vaccine_name_raw: "MMR", quantity: 15, vaccine_id: "v-mmr", matched: true },
      ]);
    });

    it("ignores non-Received notification types (e.g. Bounce)", async () => {
      const response = await POST(
        jsonRequest(snsNotificationBody({}, { notificationType: "Bounce", content: undefined }), {
          "x-amz-sns-message-type": "Notification",
        })
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    });

    it("handles a multipart/alternative + quoted-printable MIME body", async () => {
      const boundary = "BOUNDARY-QP";
      const rawMime = [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Flu Quad 2025-26=2C 40",
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "",
        "<p>Flu Quad 2025-26, 40</p>",
        `--${boundary}--`,
        "",
      ].join(CRLF);

      const insert = vi.fn(async () => ({ error: null }));
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient(insert) as never);

      const response = await POST(
        jsonRequest(
          snsNotificationBody({}, { content: Buffer.from(rawMime, "utf-8").toString("base64") }),
          { "x-amz-sns-message-type": "Notification" }
        )
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ linesTotal: 1, matchedCount: 1, unmatchedCount: 0 });
    });

    it("rejects a bad secret on an SNS Notification post", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      const response = await POST(
        jsonRequest(snsNotificationBody(), {
          "x-amz-sns-message-type": "Notification",
          "x-ses-webhook-secret": "wrong",
        })
      );
      expect(response.status).toBe(401);
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    });

    it("accepts an SNS Notification authorized via ?secret= query param", async () => {
      process.env.SES_WEBHOOK_SECRET = "correct-secret";
      vi.mocked(getSupabaseServerClient).mockReturnValue(fakeSupabaseClient() as never);

      const response = await POST(
        jsonRequest(snsNotificationBody(), { "x-amz-sns-message-type": "Notification" }, "http://localhost/api/webhooks/ses?secret=correct-secret")
      );
      expect(response.status).toBe(200);
    });
  });
});
