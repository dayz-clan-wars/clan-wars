import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, flagHolds, factionTextures, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-13T12:00:00Z");

describe("flag_holds and faction_textures", () => {
  let db: Database;
  let serverId = 0;
  let bear = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    bear = f!.id;
  });

  it("inserting a faction opens exactly one faction_textures row from -infinity", async () => {
    const rows = await db.execute(sql`select texture, from_at = '-infinity'::timestamptz as open_ended, to_at from faction_textures where faction_id = ${bear}`) as unknown as { texture: string; open_ended: boolean; to_at: Date | null }[];
    expect(rows).toEqual([{ texture: "Flag_Bear", open_ended: true, to_at: null }]);
  });

  it("one hold per texture per server, whatever its kind", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await expect(db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "released", until: now, createdAt: now })).rejects.toThrow(/flag_holds_texture_uniq/);
  });

  it("one pending hold per clan", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await expect(db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: bear, kind: "pending", until: now, createdAt: now })).rejects.toThrow(/flag_holds_one_pending/);
  });

  it("one open faction_textures row per clan", async () => {
    await expect(db.insert(factionTextures).values({ factionId: bear, texture: "Flag_Wolf", fromAt: now })).rejects.toThrow(/faction_textures_one_open/);
  });

  it("rejects an unknown hold kind", async () => {
    await expect(db.execute(sql`insert into flag_holds (server_id, texture, faction_id, kind, until, created_at) values (${serverId}, 'Flag_Rex', ${bear}, 'forever', now(), now())`)).rejects.toThrow(/flag_holds_kind_valid/);
  });

  it("deleting a faction takes its holds and history with it", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await db.delete(factions).where(eq(factions.id, bear));
    expect(await db.select().from(flagHolds)).toEqual([]);
    expect(await db.select().from(factionTextures)).toEqual([]);
  });
});
