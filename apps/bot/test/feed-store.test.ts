import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgFeedStore, appendFactionEventTx, countUnposted } from "../src/feed-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("PgFeedStore", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: "1:2:3", x: "1", y: "2", z: "3", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  const append = (kind: "founded" | "disbanded", at: Date) =>
    db.transaction((tx) => appendFactionEventTx(tx, {
      serverId, factionId, kind, occurredAt: at,
      payload: { name: "Bears", tag: "BEAR", texture: "Flag_Bear" },
    }));

  it("reads unposted rows in id order", async () => {
    await append("founded", now);
    await append("disbanded", new Date(now.getTime() + 1000));
    const rows = await new PgFeedStore(db).readUnposted(10);
    expect(rows.map((r) => r.kind)).toEqual(["founded", "disbanded"]);
    expect(rows[0]!.occurredAt).toEqual(now);
    expect(rows[0]!.payload.tag).toBe("BEAR");
  });

  it("honours the limit", async () => {
    await append("founded", now);
    await append("disbanded", now);
    expect(await new PgFeedStore(db).readUnposted(1)).toHaveLength(1);
  });

  it("markPosted removes a row from the queue", async () => {
    await append("founded", now);
    const store = new PgFeedStore(db);
    const [row] = await store.readUnposted(10);
    await store.markPosted(row!.id, now);
    expect(await store.readUnposted(10)).toEqual([]);
  });

  it("counts the queue", async () => {
    await append("founded", now);
    await append("disbanded", now);
    expect(await countUnposted(db)).toBe(2);
  });

  it("⚠️ a rolled-back transition leaves no event row", async () => {
    // The feed's whole correctness is 'a row exists iff the transition
    // happened'. Nothing anywhere reconciles the two, so the transaction
    // boundary is the only thing enforcing it.
    await expect(db.transaction(async (tx) => {
      await appendFactionEventTx(tx, {
        serverId, factionId, kind: "founded", occurredAt: now,
        payload: { name: "Bears", tag: "BEAR", texture: "Flag_Bear" },
      });
      throw new Error("transition failed");
    })).rejects.toThrow("transition failed");

    expect(await countUnposted(db)).toBe(0);
  });
});
