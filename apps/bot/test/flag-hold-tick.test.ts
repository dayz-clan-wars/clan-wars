import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, events, admFiles, clanNotices, flagHolds,
  type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { FLAG_CHANGE_WINDOW_MS } from "@factions/domain";
import { flagHoldTick } from "../src/flag-hold-tick.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("flagHoldTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let BEAR = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, clan_notices, war_log_events, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;
    await seedSeason(db, serverId, now);
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: "1000.00:100.00:1000.00", createdAt: ago(60_000), activatedAt: ago(60_000), leaderDiscordId: "dB1" });
    BEAR = bear.id;
    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: now, status: "full" },
    ]);
    const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
    await db.execute(sql`insert into consumer_cursors (consumer_name, last_event_id, updated_at) values ('raise-consumer', ${rows[0]!.n}, now())`);
  });

  const pend = (until: Date) => db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: BEAR, kind: "pending", until, stampsCooldown: true, createdAt: ago(FLAG_CHANGE_WINDOW_MS) });
  const event = (at: Date) => db.insert(events).values({ serverId, admFileId, lineIndex: lineIndex++, type: "player.connected", occurredAt: at, payload: {} }).returning();
  const foldTo = (id: number) => db.execute(sql`update consumer_cursors set last_event_id = ${id} where consumer_name = 'raise-consumer'`);

  it("lapses a pending change once the raise consumer has folded past its deadline", async () => {
    await pend(now);
    const [e] = await event(new Date(now.getTime() + 1000));
    await foldTo(e!.id);
    expect(await flagHoldTick(db, new Date(now.getTime() + 60_000))).toEqual({ lapsed: 1, released: 0 });
    expect(await db.select().from(flagHolds)).toEqual([]);
    const notices = await db.select({ kind: clanNotices.kind, target: clanNotices.target, to: clanNotices.discordTargetId }).from(clanNotices).orderBy(clanNotices.id);
    expect(notices).toEqual([
      { kind: "flag_change_lapsed", target: "channel", to: null },
      { kind: "flag_change_lapsed", target: "dm", to: "dB1" },
    ]);
  });

  it("does NOT lapse while a raise logged before the deadline may still be unfolded", async () => {
    await pend(now);
    await event(new Date(now.getTime() + 1000)); // ingested, but the cursor sits before it
    expect(await flagHoldTick(db, new Date(now.getTime() + 60_000))).toEqual({ lapsed: 0, released: 0 });
    expect(await db.select().from(flagHolds)).toHaveLength(1);
  });

  it("lapses anyway one full window past the deadline, for a log that stopped", async () => {
    await pend(now);
    expect(await flagHoldTick(db, new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS))).toEqual({ lapsed: 1, released: 0 });
  });

  it("releases an expired old-flag hold silently", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: BEAR, kind: "released", until: now, createdAt: ago(1000) });
    expect(await flagHoldTick(db, now)).toEqual({ lapsed: 0, released: 1 });
    expect(await db.select().from(clanNotices)).toEqual([]);
  });
});
