import { defineConfig } from "vitest/config";

// ⚠️ This app had no vitest config at all, so it inherited no globalSetup and
// no serial file ordering — and `fold.test.ts` truncates `events`, `poles` and
// `servers`, the tables apps/ingest-worker seeds. That is one half of inbox
// item 21's symptom: this app failed under `pnpm -r test` and passed alone.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../../packages/db/src/test-setup.ts"],
  },
});
