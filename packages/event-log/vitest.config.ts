import { defineConfig } from "vitest/config";

// ⚠️ `globalSetup` creates this package's own test database. Serial files stop
// this package's two suites racing each other over the same truncate; the
// per-package database stops them racing the apps' suites — see inbox item 21.
export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    globalSetup: ["../../packages/db/src/test-setup.ts"],
  },
});
