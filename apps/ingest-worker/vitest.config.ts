import { defineConfig } from "vitest/config";

// This suite's test files truncate the SAME identity tables (servers,
// adm_files, events, raw_lines) in beforeEach. Run test files serially so
// they cannot race each other — this exact collision already occurred in
// packages/event-log and apps/bot.
//
// ⚠️ `globalSetup` creates this package's own test database. Those same four
// tables are what apps/bot and apps/projector truncate too, which is why this
// app failed under `pnpm -r test` and passed alone (inbox item 21).
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../../packages/db/src/test-setup.ts"],
  },
});
