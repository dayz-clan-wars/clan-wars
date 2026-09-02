import { describe, it, expect } from "vitest";
import { testDatabaseNameFor, testDatabaseUrlFor } from "../src/test-database-url.js";

const BASE = "postgres://factions:factions@localhost:5434/factions";

describe("testDatabaseNameFor", () => {
  it("derives one database per package, from the package name", () => {
    expect(testDatabaseNameFor("@factions/bot")).toBe("factions_test_bot");
    expect(testDatabaseNameFor("@factions/db")).toBe("factions_test_db");
    expect(testDatabaseNameFor("@factions/event-log")).toBe("factions_test_event_log");
  });

  it("gives two different packages two different databases", () => {
    // The whole point of inbox item 21: apps must not share a namespace, so
    // no two packages may ever derive the same name.
    const names = [
      "@factions/bot", "@factions/ingest-worker", "@factions/projector",
      "@factions/db", "@factions/event-log",
    ].map(testDatabaseNameFor);
    expect(new Set(names).size).toBe(names.length);
  });

  it("accepts an unscoped name", () => {
    expect(testDatabaseNameFor("factions")).toBe("factions_test_factions");
  });

  it("rejects a package name that would not survive as an identifier", () => {
    // A name that sanitises to nothing would collapse every package onto one
    // database — the exact failure this function exists to prevent — so it
    // must throw rather than return a usable-looking default.
    expect(() => testDatabaseNameFor("@factions/")).toThrow(/package name/iu);
    expect(() => testDatabaseNameFor("")).toThrow(/package name/iu);
  });

  it("cannot produce a name that collides with a real database", () => {
    // `factions` is the shared test database this change retires and
    // `factions_live` is production. The prefix is what guarantees a
    // TEST_DATABASE_URL typo can no longer point a suite at either.
    for (const pkg of ["@factions/live", "@factions/factions", "live"]) {
      const name = testDatabaseNameFor(pkg);
      expect(name.startsWith("factions_test_")).toBe(true);
      expect(name).not.toBe("factions");
      expect(name).not.toBe("factions_live");
    }
  });
});

describe("testDatabaseUrlFor", () => {
  it("keeps the base URL's host, port and credentials, and swaps the database", () => {
    expect(testDatabaseUrlFor(BASE, "@factions/bot"))
      .toBe("postgres://factions:factions@localhost:5434/factions_test_bot");
  });

  it("preserves query parameters", () => {
    expect(testDatabaseUrlFor(`${BASE}?sslmode=disable`, "@factions/db"))
      .toBe("postgres://factions:factions@localhost:5434/factions_test_db?sslmode=disable");
  });

  it("rewrites a base that already names the live database", () => {
    // ⚠️ The safety property. Before this change, a TEST_DATABASE_URL pointing
    // at `factions_live` meant the next `pnpm test` truncated real player
    // data. Now the base URL supplies only the server, never the database.
    expect(testDatabaseUrlFor(
      "postgres://factions:factions@localhost:5434/factions_live", "@factions/bot",
    )).toBe("postgres://factions:factions@localhost:5434/factions_test_bot");
  });

  it("refuses a base URL it cannot parse", () => {
    expect(() => testDatabaseUrlFor("not a url", "@factions/bot")).toThrow(/TEST_DATABASE_URL/u);
  });
});
