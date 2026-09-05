import { describe, expect, it, vi, afterEach } from "vitest";
import { isAllowedSnsHost, verifySnsSignature } from "@/lib/sns-signature";

describe("isAllowedSnsHost", () => {
  it("allows an https sns.<region>.amazonaws.com URL", () => {
    expect(isAllowedSnsHost("https://sns.us-east-1.amazonaws.com/cert.pem")).toBe(true);
  });

  it("rejects http (non-https)", () => {
    expect(isAllowedSnsHost("http://sns.us-east-1.amazonaws.com/cert.pem")).toBe(false);
  });

  it("rejects a look-alike host", () => {
    expect(isAllowedSnsHost("https://sns.us-east-1.amazonaws.com.evil.com/cert.pem")).toBe(false);
  });

  it("rejects a non-SNS amazonaws.com host", () => {
    expect(isAllowedSnsHost("https://s3.amazonaws.com/cert.pem")).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isAllowedSnsHost("not-a-url")).toBe(false);
  });
});

describe("verifySnsSignature", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when Signature is missing", async () => {
    const result = await verifySnsSignature({ Type: "Notification", SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem" });
    expect(result).toBe(false);
  });

  it("returns false when SigningCertURL host is not allowed (never fetches an untrusted host)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await verifySnsSignature({
      Type: "Notification",
      Signature: "abc",
      SignatureVersion: "1",
      SigningCertURL: "https://evil.example.com/cert.pem",
    });
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false for an unsupported SignatureVersion", async () => {
    const result = await verifySnsSignature({
      Type: "Notification",
      Signature: "abc",
      SignatureVersion: "3",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    });
    expect(result).toBe(false);
  });

  it("returns false when the signing cert can't be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 }))
    );
    const result = await verifySnsSignature({
      Type: "Notification",
      Signature: "abc",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    });
    expect(result).toBe(false);
  });
});
