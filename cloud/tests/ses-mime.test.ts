import { describe, expect, it, vi } from "vitest";
import {
  describeMimeStructure,
  extractAttachmentFromRawMime,
  extractTextFromRawMime,
  MAX_ATTACHMENT_PART_CHARS,
} from "@/lib/ses-mime";

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

  it("recurses into multipart nested two levels deep to find a text/plain part", () => {
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
    expect(extractTextFromRawMime(raw)).toBe("MMR, 15");
  });

  it("falls back to a stripped text/html part when no text/plain part exists at all", () => {
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
    expect(extractTextFromRawMime(raw)).toBe("Flu Quad 2025-26, 40");
  });

  it("falls back to the full raw text when nesting exceeds the depth cap", () => {
    // 6 levels of multipart/mixed, each containing only the next level —
    // deeper than MAX_MIME_DEPTH (4), so the text/plain part at the
    // bottom is never reached and nothing is silently dropped either.
    let raw = ["Content-Type: text/plain", "", "MMR, 15"].join(CRLF);
    for (let i = 0; i < 6; i++) {
      const boundary = `LEVEL${i}`;
      raw = [`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, raw, `--${boundary}--`, ""].join(
        CRLF
      );
    }
    const result = extractTextFromRawMime(raw);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("MMR, 15");
  });
});

describe("extractAttachmentFromRawMime", () => {
  it("extracts a base64 xlsx attachment by content-type", () => {
    const boundary = "BOUNDARY-XLSX";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="boh.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("fake xlsx bytes").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("xlsx");
    expect((result as { kind: "xlsx"; buffer: Buffer }).buffer.toString("utf-8")).toBe("fake xlsx bytes");
  });

  it("extracts a csv attachment by filename when content-type is generic", () => {
    const boundary = "BOUNDARY-CSV";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="boh.csv"',
      "",
      "Item Name,NDC/UPC,Current BOH,Stock size",
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).toEqual({ kind: "csv", text: "Item Name,NDC/UPC,Current BOH,Stock size" });
  });

  it("returns null for a non-multipart message", () => {
    expect(extractAttachmentFromRawMime(["Content-Type: text/plain", "", "hello"].join(CRLF))).toBeNull();
  });

  it("returns null when no part looks like an xlsx/csv attachment", () => {
    const boundary = "TEXTONLY";
    const raw = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Flu Quad 2025-26, 40",
      `--${boundary}--`,
      "",
    ].join(CRLF);
    expect(extractAttachmentFromRawMime(raw)).toBeNull();
  });

  // Security review fix (V-ordering-targets, 2026-09-08): reject an
  // oversized part BEFORE any decode, since xlsx@0.18.5 (fed by this
  // path) carries two open high-severity advisories.
  it("returns null for an oversized xlsx attachment part WITHOUT decoding it", () => {
    const boundary = "BOUNDARY-BIG";
    const oversized = "A".repeat(MAX_ATTACHMENT_PART_CHARS + 1);
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="boh.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      oversized,
      `--${boundary}--`,
      "",
    ].join(CRLF);

    expect(extractAttachmentFromRawMime(raw)).toBeNull();
  });

  it("still extracts a normal-size xlsx part comfortably under the size limit", () => {
    const boundary = "BOUNDARY-UNDER-LIMIT";
    const underLimit = "A".repeat(MAX_ATTACHMENT_PART_CHARS - 1000);
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="boh.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      underLimit,
      `--${boundary}--`,
      "",
    ].join(CRLF);

    expect(extractAttachmentFromRawMime(raw)).not.toBeNull();
  });

  it("finds an xlsx part nested two levels deep (mixed -> related -> attachment)", () => {
    const outer = "OUTER-NEST";
    const inner = "INNER-NEST";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      "",
      `--${outer}`,
      `Content-Type: multipart/related; boundary="${inner}"`,
      "",
      `--${inner}`,
      "Content-Type: text/plain",
      "",
      "Automatic delivery from scheduled saved search",
      `--${inner}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="Vaccine BOH.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("fake nested xlsx bytes").toString("base64"),
      `--${inner}--`,
      `--${outer}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("xlsx");
    expect((result as { kind: "xlsx"; buffer: Buffer }).buffer.toString("utf-8")).toBe("fake nested xlsx bytes");
  });

  it("decodes an RFC 2231 filename* filename to recognize an xlsx attachment", () => {
    const boundary = "BOUNDARY-RFC2231";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename*=utf-8''Vaccine%20BOH.xlsx",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("rfc2231 xlsx bytes").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("xlsx");
    expect((result as { kind: "xlsx"; buffer: Buffer }).buffer.toString("utf-8")).toBe("rfc2231 xlsx bytes");
  });

  it("recognizes a legacy .xls part by application/vnd.ms-excel content-type", () => {
    const boundary = "BOUNDARY-XLS";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: application/vnd.ms-excel; name="Vaccine BOH.xls"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("legacy xls bytes").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("xlsx");
    expect((result as { kind: "xlsx"; buffer: Buffer }).buffer.toString("utf-8")).toBe("legacy xls bytes");
  });

  it("treats application/octet-stream with an .xlsx filename as xlsx", () => {
    const boundary = "BOUNDARY-OCTET";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="Vaccine BOH.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("octet stream xlsx bytes").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("xlsx");
    expect((result as { kind: "xlsx"; buffer: Buffer }).buffer.toString("utf-8")).toBe("octet stream xlsx bytes");
  });

  it("logs and returns null for an unsupported attachment type (zip), never its body", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boundary = "BOUNDARY-ZIP";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: application/zip",
      'Content-Disposition: attachment; filename="report.zip"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("super secret zip body content").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    expect(extractAttachmentFromRawMime(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unsupported attachment type=application/zip name="report.zip"')
    );
    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain("secret zip body");
      }
    }
    warnSpy.mockRestore();
  });

  it("extracts a base64 pdf attachment by content-type (application/pdf)", () => {
    const boundary = "BOUNDARY-PDF-CT";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: application/pdf; name="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("fake pdf bytes").toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("pdf");
    expect((result as { kind: "pdf"; buffer: Buffer }).buffer.toString("utf-8")).toBe("fake pdf bytes");
  });

  // The real PioneerRx "AppExport: Vaccine BOH" email (prod finding,
  // 2026-09-09 12:00pm CST): multipart/mixed with a text/plain body part
  // and ONE attachment part that is application/octet-stream (NOT
  // application/pdf) named "_AppExport_Vaccine-BOH.pdf", base64-encoded
  // — this is the shape the filename-pattern fallback exists for.
  it("recognizes the real Pioneer BOH email shape: octet-stream + '_AppExport_Vaccine-BOH.pdf' filename", () => {
    const boundary = "BOUNDARY-PIONEER-BOH";
    const pdfBytes = Buffer.from("%PDF-1.4 fake pioneer boh pdf bytes");
    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Automatic delivery from scheduled saved search: AppExport - Vaccine BOH",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="_AppExport_Vaccine-BOH.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdfBytes.toString("base64"),
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("pdf");
    expect((result as { kind: "pdf"; buffer: Buffer }).buffer.equals(pdfBytes)).toBe(true);
  });

  // The prod incident's actual attachment was 7952 base64 chars — a real
  // SES/SMTP body that size arrives CRLF-line-wrapped (76 chars/line,
  // RFC 2045), not as one giant line like the fixture above. Confirms
  // extractAttachmentFromRawMime's `body.replace(/\s/g, "")` strips the
  // embedded CRLFs correctly and the decoded buffer both round-trips
  // byte-for-byte AND starts with the `%PDF-` magic bytes pdfjs expects.
  it("decodes a realistic multi-line, CRLF-wrapped base64 pdf attachment (starts with %PDF-)", () => {
    const boundary = "BOUNDARY-PIONEER-BOH-WRAPPED";
    // A few hundred bytes of "PDF-shaped" content is enough to force
    // multiple wrapped base64 lines while staying a fast, synthetic
    // (non-PHI) fixture — the real incident's PDF bytes are never
    // reproduced here.
    const pdfBytes = Buffer.from(`%PDF-1.4\n${"Fluad Syringe 57.5 0.5 | ".repeat(60)}\n%%EOF`);
    const base64 = pdfBytes.toString("base64");
    const wrappedLines: string[] = [];
    for (let i = 0; i < base64.length; i += 76) {
      wrappedLines.push(base64.slice(i, i + 76));
    }
    expect(wrappedLines.length).toBeGreaterThan(1); // actually multi-line, not a fluke

    const raw = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Automatic delivery from scheduled saved search: AppExport - Vaccine BOH",
      `--${boundary}`,
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="_AppExport_Vaccine-BOH.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      ...wrappedLines,
      `--${boundary}--`,
      "",
    ].join(CRLF);

    const result = extractAttachmentFromRawMime(raw);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("pdf");
    const buffer = (result as { kind: "pdf"; buffer: Buffer }).buffer;
    expect(buffer.equals(pdfBytes)).toBe(true);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("describeMimeStructure", () => {
  it("emits one structure-only line per part, recursively, with no body text", () => {
    const outer = "OUTER-DESC";
    const inner = "INNER-DESC";
    const secretBody = "Automatic delivery from scheduled saved search: SECRET_MARKER";
    const raw = [
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      "",
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      "",
      `--${inner}`,
      "Content-Type: text/plain",
      "",
      secretBody,
      `--${inner}--`,
      `--${outer}`,
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="Vaccine BOH.xlsx"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("xlsx bytes").toString("base64"),
      `--${outer}--`,
      "",
    ].join(CRLF);

    const lines = describeMimeStructure(raw);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain("depth=0 idx=0 type=multipart/mixed");
    expect(lines.some((l) => l.includes("type=multipart/alternative"))).toBe(true);
    expect(lines.some((l) => l.includes("type=text/plain"))).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes('type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') &&
          l.includes('name="Vaccine BOH.xlsx"') &&
          l.includes("enc=base64") &&
          /bodyChars=\d+/.test(l)
      )
    ).toBe(true);

    for (const line of lines) {
      expect(line).not.toContain(secretBody);
      expect(line).not.toContain("SECRET_MARKER");
    }
  });

  it("returns an empty array for a raw string with no header/body separator", () => {
    expect(describeMimeStructure("not a valid mime message")).toEqual([]);
  });
});
