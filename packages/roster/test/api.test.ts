import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, verificationChallenges, type Database } from "@factions/db";
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
    // The names that are constants, not wrappers: they stay plain re-exports on index,
    // plus makeRoster itself, which is a factory export, not a method on the instance it returns.
    const notWrappers = ["BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE", "ISSUE_OUTCOME_KINDS", "NOTIFICATIONS_PAGE_SIZE", "REPORT_REASONS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX", "makeRoster"];
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
    // A default (real-clock) getNow would see this challenge's expiresAt as
    // years in the future and report `ended: null`. Only an implementation
    // that actually calls the injected getNow — and gets FROZEN back — reads
    // it as already expired. This is the one branch of linkStatusDb whose
    // result depends on which clock it used, so it is the one worth pinning.
    const FROZEN = new Date("2030-06-01T00:00:00Z");
    await db.insert(verificationChallenges).values({
      discordId: D,
      targetDayzId: UID,
      sequence: ["a", "b", "c"],
      issuedAt: new Date("2029-12-01T00:00:00Z"),
      expiresAt: new Date("2029-12-02T00:00:00Z"),
    });
    const roster = makeRoster(() => db, () => FROZEN);
    const status = await roster.linkStatus(D);
    expect(status.link).toBeNull();
    expect(status.challenge).toBeNull();
    expect(status.ended).toBe("expired");
  });
});
