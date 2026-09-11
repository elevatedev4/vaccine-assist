import { describe, expect, it, vi } from "vitest";
import { utils, write } from "xlsx";
import {
  MAX_RETAINED_ATTACHMENTS,
  buildAttachmentKey,
  getInboundAttachmentByKey,
  headerInfoFromMatrix,
  isVaccinationLogHeaderLine,
  matrixFromDelimitedText,
  matrixFromXlsxBuffer,
  sanitizeFilenameForKey,
  selectKeysToEvict,
} from "@/lib/inbound-attachments";
import type { getSupabaseServerClient } from "@/lib/supabase/server";

describe("sanitizeFilenameForKey", () => {
  it("keeps a plain filename unchanged", () => {
    expect(sanitizeFilenameForKey("boh-report.xlsx")).toBe("boh-report.xlsx");
  });

  it("replaces spaces and other unsafe characters with underscores", () => {
    expect(sanitizeFilenameForKey("Vaccine BOH (1).xlsx")).toBe("Vaccine_BOH_1_.xlsx");
  });

  it("strips path separators and colons", () => {
    expect(sanitizeFilenameForKey("../../etc/passwd:evil")).toBe(".._.._etc_passwd_evil");
  });

  it("falls back to 'attachment' when everything is stripped", () => {
    expect(sanitizeFilenameForKey("???")).toBe("attachment");
  });

  it("caps very long filenames", () => {
    const long = "a".repeat(500) + ".xlsx";
    expect(sanitizeFilenameForKey(long).length).toBeLessThanOrEqual(120);
  });
});

describe("buildAttachmentKey", () => {
  it("embeds the ISO receivedAt and sanitized filename", () => {
    expect(buildAttachmentKey("2026-09-11T20:39:00.000Z", "Vaccine BOH.xlsx")).toBe(
      "inbound_attachment:2026-09-11T20:39:00.000Z:Vaccine_BOH.xlsx"
    );
  });
});

describe("selectKeysToEvict", () => {
  it("evicts nothing when at or under the cap", () => {
    const keys = ["inbound_attachment:2026-01-01T00:00:00.000Z:a.xlsx", "inbound_attachment:2026-01-02T00:00:00.000Z:b.xlsx"];
    expect(selectKeysToEvict(keys, MAX_RETAINED_ATTACHMENTS)).toEqual([]);
  });

  it("evicts the oldest keys (by ISO timestamp) beyond the cap", () => {
    const keys = Array.from({ length: 5 }, (_, i) => `inbound_attachment:2026-01-0${i + 1}T00:00:00.000Z:file.xlsx`);
    // Shuffle to prove sort order doesn't depend on input order.
    const shuffled = [keys[3], keys[0], keys[4], keys[1], keys[2]];
    const evicted = selectKeysToEvict(shuffled, 3);
    expect(evicted).toEqual([keys[0], keys[1]]);
  });

  it("keeps exactly `cap` newest keys", () => {
    const keys = Array.from({ length: 32 }, (_, i) => `inbound_attachment:2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z:f.xlsx`);
    const evicted = selectKeysToEvict(keys, 30);
    expect(evicted).toHaveLength(2);
    expect(evicted).toEqual([keys[0], keys[1]]);
  });
});

describe("header-row extraction", () => {
  it("skips leading blank rows and joins the first non-empty row's cells", () => {
    const matrix = [[null, null], ["Item Name", "NDC/UPC", "Current BOH"], ["Flu Quad", "12345", 10]];
    expect(headerInfoFromMatrix(matrix)).toEqual({
      headerLine: "Item Name | NDC/UPC | Current BOH",
      rowCount: 3,
    });
  });

  it("returns null for an entirely empty matrix", () => {
    expect(headerInfoFromMatrix([])).toBeNull();
    expect(headerInfoFromMatrix([[null, null], ["", ""]])).toBeNull();
  });

  it("extracts the header row from a synthetic xlsx built with the xlsx lib", () => {
    const sheet = utils.aoa_to_sheet([
      ["Patient", "Vaccine", "Completed date", "Lot"],
      ["Jane Synthetic", "Flu Quad", "2026-09-10", "LOT123"],
      ["John Synthetic", "MMR", "2026-09-11", "LOT456"],
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const matrix = matrixFromXlsxBuffer(buffer);
    const info = headerInfoFromMatrix(matrix);
    expect(info).not.toBeNull();
    expect(info?.headerLine).toBe("Patient | Vaccine | Completed date | Lot");
    expect(info?.rowCount).toBe(3);
    expect(isVaccinationLogHeaderLine(info!.headerLine)).toBe(true);
  });

  it("extracts the header row from a BOH-shaped synthetic xlsx (not a vaccination log)", () => {
    const sheet = utils.aoa_to_sheet([
      ["Item Name", "NDC/UPC", "Current BOH"],
      ["Flu Quad 2025-26", "12345", 10],
    ]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buffer = write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const info = headerInfoFromMatrix(matrixFromXlsxBuffer(buffer));
    expect(info?.headerLine).toBe("Item Name | NDC/UPC | Current BOH");
    expect(isVaccinationLogHeaderLine(info!.headerLine)).toBe(false);
  });

  it("parses a delimited (csv) header row", () => {
    const matrix = matrixFromDelimitedText("Completed Date,Patient,Vaccine\n2026-09-10,Jane,Flu", ",");
    const info = headerInfoFromMatrix(matrix);
    expect(info?.headerLine).toBe("Completed Date | Patient | Vaccine");
    expect(isVaccinationLogHeaderLine(info!.headerLine)).toBe(true);
  });
});

describe("isVaccinationLogHeaderLine", () => {
  it("is case-insensitive", () => {
    expect(isVaccinationLogHeaderLine("Patient | COMPLETED DATE | Vaccine")).toBe(true);
    expect(isVaccinationLogHeaderLine("Item Name | NDC/UPC | Current BOH")).toBe(false);
  });
});

// Security review fix (2026-09-11): app_setting is a SHARED table (also
// holds ordering.walk_in_pct, lots.bud_enabled_products, ...) — a `key`
// without the inbound_attachment: prefix must be refused WITHOUT ever
// querying Supabase, not just filtered out after the fact, so an
// unrelated setting can never be read through the attachment-download
// path. See also tests/inbound-attachments-route.test.ts for the same
// guard exercised at the route layer.
describe("getInboundAttachmentByKey", () => {
  function fakeSupabase(row: { value: unknown } | null) {
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return { client: { from } as unknown as ReturnType<typeof getSupabaseServerClient>, from, eq, maybeSingle };
  }

  it("runs the lookup for a properly-prefixed key", async () => {
    const attachment = {
      receivedAt: "2026-09-11T20:39:00.000Z",
      from: "",
      subject: "",
      filename: "f.xlsx",
      contentType: "application/octet-stream",
      bytes: 1,
      sha256: "a",
      base64: "YQ==",
    };
    const key = "inbound_attachment:2026-09-11T20:39:00.000Z:f.xlsx";
    const { client, from, eq } = fakeSupabase({ value: attachment });

    const result = await getInboundAttachmentByKey(client, key);

    expect(result).toEqual(attachment);
    expect(from).toHaveBeenCalledWith("app_setting");
    expect(eq).toHaveBeenCalledWith("key", key);
  });

  it("returns null for a non-prefixed key WITHOUT touching Supabase at all", async () => {
    const { client, from } = fakeSupabase(null);

    const result = await getInboundAttachmentByKey(client, "ordering.walk_in_pct");

    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
