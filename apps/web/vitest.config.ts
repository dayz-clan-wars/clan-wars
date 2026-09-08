import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // `@/` is tsconfig's path alias; app modules the tests import (app/guide/index.ts) use it.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
