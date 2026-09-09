import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import nextConfig from "../next.config";

/**
 * Regression guard for the 2026-09-09 Vercel prod incident (pdfjs-dist's
 * "fake worker" setup failing to find pdf.worker.mjs once Next's webpack
 * build inlined pdfjs-dist into a server chunk — see the "Vercel
 * serverless fix" section of lib/on-hand/pioneer-boh-pdf.ts's doc
 * comment for the full mechanism). Both settings below are required
 * TOGETHER: serverExternalPackages keeps pdf.mjs running from its real
 * on-disk location (so its own relative worker import resolves
 * correctly again); outputFileTracingIncludes guarantees pdf.worker.mjs
 * itself is copied into the deployed function regardless of whether
 * @vercel/nft's static analysis can trace pdfjs's runtime-computed
 * import. Losing either one silently reintroduces the prod failure —
 * `next build` succeeds either way, so nothing else would catch this.
 */
describe("next.config.ts pdfjs-dist Vercel runtime settings", () => {
  it("externalizes pdfjs-dist so it isn't inlined into a webpack server chunk", () => {
    expect(nextConfig.serverExternalPackages).toContain("pdfjs-dist");
  });

  it("explicitly traces pdf.worker.mjs into every route that can reach parsePioneerBohPdf", () => {
    const includes = nextConfig.outputFileTracingIncludes;
    expect(includes).toBeDefined();
    for (const routeGlob of ["/api/webhooks/ses/**", "/api/on-hand/upload/**"]) {
      expect(includes![routeGlob]).toEqual(
        expect.arrayContaining(["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"])
      );
    }
  });

  it("the traced worker path actually resolves to a real file on disk", () => {
    const require = createRequire(import.meta.url);
    const pdfjsDir = require.resolve("pdfjs-dist/legacy/build/pdf.mjs").replace(/pdf\.mjs$/, "");
    expect(existsSync(`${pdfjsDir}pdf.worker.mjs`)).toBe(true);
  });
});
