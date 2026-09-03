import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { actorGamertagTx } from "../src/feed-actor.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("actorGamertagTx", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table identity_links, players restart identity cascade`);
    });
  });

  it("⚠️ prefers the player's CURRENT gamertag over the one frozen at verification", async () => {
    // identity_links.gamertag is a label captured at verification time; its
    // own schema comment warns that players rename. Printing the stale one
    // names somebody who no longer exists.
    await db.insert(players).values({
      dayzId: "u1", gamertag: "NewName", firstSeenAt: now, lastSeenAt: now,
    });
    await db.insert(identityLinks).values({
      discordId: "d1", dayzId: "u1", gamertag: "OldName", verifiedAt: now,
    });

    const name = await db.transaction((tx) => actorGamertagTx(tx, "d1"));
    expect(name).toBe("NewName");
  });

  it("falls back to the link's gamertag when the player row is missing", async () => {
    await db.insert(identityLinks).values({
      discordId: "d1", dayzId: "u1", gamertag: "OldName", verifiedAt: now,
    });
    expect(await db.transaction((tx) => actorGamertagTx(tx, "d1"))).toBe("OldName");
  });

  it("returns undefined for an unlinked Discord id", async () => {
    expect(await db.transaction((tx) => actorGamertagTx(tx, "nobody"))).toBeUndefined();
  });
});
