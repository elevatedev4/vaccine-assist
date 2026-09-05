import { describe, expect, it } from "vitest";
import { extractTextFromRawMime } from "@/lib/ses-mime";

const CRLF = "\r\n";

describe("extractTextFromRawMime", () => {
  it("extracts a simple non-multipart text/plain message", () => {
    const raw = ["Content-Type: text/plain; charset=UTF-8", "", "Flu Quad 2025-26, 40" + CRLF + "MMR, 15"].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("Flu Quad 2025-26, 40\nMMR, 15");
  });

  it("defaults to text/plain when no Content-Type header is present", () => {
    const raw = ["Subject: On-hand count", "", "Comirnaty, 12"].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("Comirnaty, 12");
  });

  it("decodes a quoted-printable non-multipart body", () => {
    // "=3D" -> "=", "=E2=80=93" is an em dash but we just need an
    // encoded byte round-tripping; use "=2C" -> "," to keep the parser
    // contract (comma-delimited) intact.
    const raw = [
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Flu Quad 2025-26=2C 40",
    ].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("Flu Quad 2025-26, 40");
  });

  it("decodes a base64 non-multipart body", () => {
    const body = Buffer.from("Flu Quad 2025-26, 40\nMMR, 15", "utf-8").toString("base64");
    const raw = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", body].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("Flu Quad 2025-26, 40\nMMR, 15");
  });

  it("takes the text/plain part out of a multipart/alternative message", () => {
    const boundary = "BOUNDARY123";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Flu Quad 2025-26, 40",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Flu Quad 2025-26, 40</p>",
      `--${boundary}--`,
      "",
    ].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("Flu Quad 2025-26, 40");
  });

  it("decodes a quoted-printable text/plain part inside multipart/alternative", () => {
    const boundary = "BOUNDARY456";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "MMR=2C 15",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>MMR, 15</p>",
      `--${boundary}--`,
      "",
    ].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("MMR, 15");
  });

  it("decodes a base64 text/plain part inside multipart/alternative", () => {
    const boundary = "BOUNDARY789";
    const encoded = Buffer.from("MMR, 15", "utf-8").toString("base64");
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encoded,
      `--${boundary}--`,
      "",
    ].join(CRLF);
    expect(extractTextFromRawMime(raw)).toBe("MMR, 15");
  });

  it("falls back to the full raw text when multipart nests beyond one level", () => {
    const outer = "OUTER";
    const inner = "INNER";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      "",
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      "",
      `--${inner}`,
      "Content-Type: text/plain",
      "",
      "MMR, 15",
      `--${inner}--`,
      `--${outer}--`,
      "",
    ].join(CRLF);
    const result = extractTextFromRawMime(raw);
    // Nothing is silently dropped — the caller still gets non-empty
    // content (the raw MIME) rather than an empty string.
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("multipart/mixed");
  });

  it("falls back to the full raw text when no text/plain part exists at all", () => {
    const boundary = "HTMLONLY";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Flu Quad 2025-26, 40</p>",
      `--${boundary}--`,
      "",
    ].join(CRLF);
    const result = extractTextFromRawMime(raw);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("multipart/alternative");
  });
});
