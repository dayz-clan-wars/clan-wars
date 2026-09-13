import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "../src/api";
import { ROSTER_EXPORTS } from "./roster-exports";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-1";
const UID = "U".repeat(40);

/**
 * The factory is what lets the bot run the site's rules over its own handle
 * (spec §3.1). Two things have to stay true forever: the instance carries
 * every name the singleton exports, and an injected handle reaches the same
 * rows. Anything subtler is `writes.test.ts`'s job, not this file's.
 */
describe("makeRoster", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, faction_members, declarations, poles, factions, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
  });

  it("carries every function the singleton exports", async () => {
    const roster = makeRoster(() => db, () => NOW);
    const singleton = await import("../src/index");
    // The eight names that are constants, not wrappers: they stay plain re-exports on index,
    // plus makeRoster itself, which is a factory export, not a method on the instance it returns.
    const notWrappers = ["BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE", "ISSUE_OUTCOME_KINDS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX", "makeRoster"];
    const wrappers = ROSTER_EXPORTS.filter((n) => !notWrappers.includes(n));
    expect(Object.keys(roster).sort()).toEqual([...wrappers].sort());
    for (const name of wrappers) {
      expect(typeof singleton[name as keyof typeof singleton]).toBe("function");
    }
  });

  it("reads through the handle it was given", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const roster = makeRoster(() => db, () => NOW);
    const viewer = await roster.viewerFor(D);
    expect(viewer.link?.gamertag).toBe("Ada");
  });

  it("takes its clock from getNow, so a caller can freeze time", async () => {
    const roster = makeRoster(() => db, () => NOW);
    const status = await roster.linkStatus(D);
    expect(status.link).toBeNull();
    expect(status.challenge).toBeNull();
  });
});
