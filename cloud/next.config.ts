import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // pdfjs-dist (lib/on-hand/pioneer-boh-pdf.ts) resolves its own worker
  // module at runtime via a RELATIVE `import("./pdf.worker.mjs")`. Left
  // to Next's default webpack bundling, pdfjs-dist gets inlined into a
  // server chunk and that relative path breaks (it resolves against the
  // chunk's own location, which has no pdf.worker.mjs sibling) — this is
  // the Vercel prod incident 2026-09-09 ("Setting up fake worker
  // failed"). `serverExternalPackages` keeps pdfjs-dist OUT of the
  // webpack bundle (required straight from its real node_modules
  // directory at runtime instead), so its internal relative import
  // resolves against its own real file layout again.
  serverExternalPackages: ["pdfjs-dist"],
  // Belt-and-suspenders: @vercel/nft's static file-tracing can't see a
  // runtime-computed `import(variable)` either (bundled or not), so
  // pdf.worker.mjs still isn't guaranteed to get copied into the
  // deployed function's file set without being told explicitly. Every
  // route that can reach parsePioneerBohPdf needs this.
  outputFileTracingIncludes: {
    "/api/webhooks/ses/**": ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/on-hand/upload/**": ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
};

export default nextConfig;
