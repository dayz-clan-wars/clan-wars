import { defineConfig } from "vitest/config";

// ⚠️ `globalSetup` creates this package's own test database
// (`factions_test_verification`). Without it the suites cannot connect at
// all, which is the intended failure — see inbox item 21 and packages/db.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../db/src/test-setup.ts"],
  },
});
