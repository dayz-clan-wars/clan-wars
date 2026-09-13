import { defineConfig } from "vitest/config";

// No database: every test here is over in-memory tables. No globalSetup, so
// this package does not create a factions_test_copy it would never use.
export default defineConfig({});
