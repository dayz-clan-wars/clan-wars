import { defineConfig } from "vitest/config";

// Both DB suites truncate tables in beforeAll. They currently touch disjoint
// tables, but that is a coincidence, not a guarantee — the first suite that
// truncates a table another one seeds would race. Serialize the files.
export default defineConfig({
  test: { fileParallelism: false },
});
