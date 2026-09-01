import { defineConfig } from "vitest/config";

// This suite's test files truncate the SAME identity tables (servers,
// adm_files, events, raw_lines) in beforeEach. Run test files serially so
// they cannot race each other — this exact collision already occurred in
// packages/event-log and apps/bot.
export default defineConfig({
  test: { fileParallelism: false },
});
