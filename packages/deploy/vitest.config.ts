import { defineConfig } from "vitest/config";

// No database: every decision here is a pure function over strings. No
// globalSetup, so this package does not create a factions_test_deploy it
// would never use.
export default defineConfig({});
