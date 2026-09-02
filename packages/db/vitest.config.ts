import { defineConfig } from "vitest/config";

// Both DB suites truncate tables in beforeAll. They currently touch disjoint
// tables, but that is a coincidence, not a guarantee — the first suite that
// truncates a table another one seeds would race. Serialize the files.
//
// ⚠️ `globalSetup` creates this package's own test database. Without it the
// suites cannot connect at all, which is the intended failure: the previous
// arrangement had every package share one database and truncate the others'
// tables (inbox item 21), and a silent fallback would restore exactly that.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./src/test-setup.ts"],
  },
});
