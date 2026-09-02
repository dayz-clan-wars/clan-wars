import { defineConfig } from "vitest/config";

// Four database-backed suites in this app truncate the SAME identity tables in
// beforeAll. Run test files serially so they cannot race each other. This exact
// collision already occurred in packages/event-log.
//
// ⚠️ `globalSetup` creates this package's own test database (`factions_test_bot`).
// Serial files stop this app's suites racing each other; the per-package
// database is what stops them racing the OTHER apps' suites — see inbox item 21.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../../packages/db/src/test-setup.ts"],
  },
});
