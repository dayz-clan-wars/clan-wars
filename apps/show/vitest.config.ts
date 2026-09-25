import { defineConfig } from "vitest/config";

// ⚠️ `globalSetup` creates this package's own test database (`factions_test_show`).
// Without it the story suites cannot connect at all, which is the intended failure
// (inbox item 21). Serial files: the story suites truncate the same tables.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../../packages/db/src/test-setup.ts"],
  },
});
