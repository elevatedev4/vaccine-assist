import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Isolated from tests/pioneer-boh-pdf.test.ts (which uses the REAL
 * pdfjs-dist against pdf-lib-built fixtures) because this file mocks
 * "pdfjs-dist/legacy/build/pdf.mjs" entirely, to simulate a pdfjs
 * getDocument() call that never resolves — the only way to exercise the
 * PDF_PARSE_TIMEOUT_MS wall-clock guard (hardening follow-up,
 * 2026-09-09) without an actual 20-second wait in the test suite (fake
 * timers advance the clock instead).
 *
 * `vi.mock` factories are hoisted above every other statement in the
 * file, so the mock fns they reference must be created via
 * `vi.hoisted()` (plain top-level `const`s would still throw
 * "Cannot access before initialization").
 */
const { mockDestroy, mockGetDocument } = vi.hoisted(() => {
  const mockDestroy = vi.fn(async () => {});
  const mockGetDocument = vi.fn(() => ({
    // Never resolves/rejects — simulates pdfjs getting stuck on a
    // pathological document.
    promise: new Promise(() => {}),
    destroy: mockDestroy,
  }));
  return { mockDestroy, mockGetDocument };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mockGetDocument,
}));

import { parsePioneerBohPdf } from "@/lib/on-hand/pioneer-boh-pdf";

describe("parsePioneerBohPdf timeout guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockDestroy.mockClear();
    mockGetDocument.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves null and logs 'pdf parse timeout' when pdfjs hangs past the 20s budget", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resultPromise = parsePioneerBohPdf(Buffer.from("%PDF-1.4 fake, never actually parsed"));
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("parsePioneerBohPdf: pdf parse timeout");

    warnSpy.mockRestore();
  });

  it("still calls loadingTask.destroy() on the timeout path (no leaked pdfjs resources)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const resultPromise = parsePioneerBohPdf(Buffer.from("%PDF-1.4 fake, never actually parsed"));
    await vi.advanceTimersByTimeAsync(20_000);
    await resultPromise;

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("does not fire the timeout warning for a parse that would finish well within budget", async () => {
    // A separate, quickly-resolving loadingTask for this one test only.
    const quickDestroy = vi.fn(async () => {});
    mockGetDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 0 }),
      destroy: quickDestroy,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await parsePioneerBohPdf(Buffer.from("%PDF-1.4 fake, resolves immediately"));

    expect(result).toEqual({ rows: [], pages: 0, headerFound: false });
    expect(quickDestroy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith("parsePioneerBohPdf: pdf parse timeout");

    warnSpy.mockRestore();
  });
});
