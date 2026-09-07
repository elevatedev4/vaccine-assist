import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.join(dirname, "tests", "mocks", "server-only.ts"),
      "@": dirname,
    },
  },
  // V-cloud-tabs: tests/layout-nav.test.ts imports app/layout.tsx directly
  // (a plain server component, called as a function — no DOM needed) to
  // check its returned element tree without jsdom/testing-library. Without
  // this, esbuild's default JSX transform emits bare `React.createElement`
  // calls with no implicit import, which throws "React is not defined" the
  // moment any .tsx module is imported in a test — this project's tsconfig
  // already targets React 18's automatic runtime (no next.js file needs
  // its own `import React` for JSX), so tests need the same setting.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
