/**
 * Shared helpers for POST /api/on-hand/upload — split out of the route
 * file because Next.js's App Router rejects any named export from a
 * route.ts besides its fixed method-handler/config set (same reason
 * app/settings/sections.tsx is split out of page.tsx — see that file's
 * doc comment), and MAX_UPLOAD_BYTES needs to be importable from the
 * test file without duplicating the literal.
 *
 * Raised from 200 KB to 2 MB (V-ordering-targets, Will 2026-09-08) — a
 * Pioneer xlsx export is a binary spreadsheet, comfortably larger than a
 * hand-typed text list, and the real fixture used to build this feature
 * (~47 rows) is already a few dozen KB once SheetJS's zip container
 * overhead is counted.
 */

import type { UploadPayload } from "@/lib/on-hand/pioneer-boh";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

const XLSX_EXTENSION_PATTERN = /\.xlsx$/i;
const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

function looksLikeXlsx(filename: string, mimeType: string): boolean {
  if (XLSX_EXTENSION_PATTERN.test(filename)) return true;
  return XLSX_MIME_TYPES.has(mimeType);
}

/**
 * Reads the request body into an UploadPayload — either a decoded text
 * string (the legacy "VaccineName, Quantity" lines, or a Pioneer
 * csv/tsv table) or a raw Buffer for an xlsx file (lib/on-hand/pioneer-boh.ts
 * parses that with SheetJS). Multipart uploads are routed to `xlsx` by
 * filename extension or declared MIME type; a raw (non-multipart) POST
 * body is always treated as text — xlsx is a binary zip container that
 * can't round-trip through a raw text body reliably, and every caller
 * that would send one (the upload button) always posts multipart.
 */
export async function extractUploadPayload(request: Request): Promise<UploadPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof Blob)) {
      throw new Error('Expected a "file" field in the upload.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes).`);
    }

    const filename = file instanceof File ? file.name : "";
    if (looksLikeXlsx(filename, file.type)) {
      const buffer = Buffer.from(await file.arrayBuffer());
      return { kind: "xlsx", buffer };
    }
    return { kind: "text", text: await file.text() };
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes).`);
  }
  return { kind: "text", text };
}
