import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // `@/` is tsconfig's path alias; app modules the tests import (app/guide/index.ts) use it.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  // Next compiles JSX with the automatic runtime (tsconfig has jsx: preserve
  // and no React import anywhere); a test that renders a component needs
  // vitest's esbuild told the same, or it emits `React.createElement`.
  esbuild: { jsx: "automatic" },
  test: { include: ["test/**/*.test.ts"] },
});
