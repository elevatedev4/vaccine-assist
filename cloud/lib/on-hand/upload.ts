/**
 * Shared helpers for POST /api/on-hand/upload — split out of the route
 * file because Next.js's App Router rejects any named export from a
 * route.ts besides its fixed method-handler/config set (same reason
 * app/settings/sections.tsx is split out of page.tsx — see that file's
 * doc comment), and MAX_UPLOAD_BYTES needs to be importable from the
 * test file without duplicating the literal.
 */

// 200 KB cap per Will's brief, applied to either upload shape (multipart
// file size, or a raw body's UTF-8 byte length once read).
export const MAX_UPLOAD_BYTES = 200 * 1024;

export async function extractUploadContent(request: Request): Promise<string> {
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
    return await file.text();
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_UPLOAD_BYTES) {
    throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes).`);
  }
  return text;
}
