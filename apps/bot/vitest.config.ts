import { defineConfig } from "vitest/config";

// Later tasks in this plan add four database-backed suites to this app, and
// they all truncate the SAME identity tables in beforeAll. Run test files
// serially so they cannot race each other. This exact collision already
// occurred in packages/event-log during this plan.
export default defineConfig({
  test: { fileParallelism: false },
});
