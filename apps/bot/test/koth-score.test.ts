import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, kothEvents, servers, serverRestarts, events, kills,
  identityLinks, players, admFiles, awardGrants, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { KILLS_CONSUMER } from "../src/kills-tick.js";
import { kothWindow, scoringReady, kothKills, scoreAndAward } from "../src/koth-score.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const END = at("2026-10-03T22:00:00Z");
const HILL = { x: 8675, z: 6635 };

describe("koth scoring", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0; let rowId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table koth_events, award_grants, clan_notices, kills, events, adm_files, identity_links, players, server_restarts, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f1.ADM", bootAt: SLOT, linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0;
    await db.insert(serverRestarts).values([
      { serverId, scheduledFor: SLOT, issuedAt: at("2026-10-03T20:00:04Z"), outcome: "restarted" },
      { serverId, scheduledFor: END, issuedAt: at("2026-10-03T22:00:04Z"), outcome: "restarted" },
    ]);
    const [r] = await db.insert(kothEvents).values({
      serverId, slotAt: SLOT, location: "lembork", centreX: String(HILL.x), centreZ: String(HILL.z),
      state: "live", scheduledByDiscordId: "admin", announcedAt: SLOT, openedAt: SLOT,
    }).returning();
    rowId = r!.id;
  });

  /** One player.killed event + its kills row, as the kills consumer would write it. */
  async function kill(killer: string, victim: string, iso: string, victimPos: { x: number; z: number } | null, over: Partial<typeof kills.$inferInsert> = {}) {
    const payload = { killerDayzId: killer, victimDayzId: victim, ...(victimPos ? { victimPos: { x: victimPos.x, y: 100, z: victimPos.z } } : {}) };
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.killed", occurredAt: at(iso), payload }).returning();
    await db.insert(kills).values({ serverId, eventId: e!.id, occurredAt: at(iso), victimDayzId: victim, killerDayzId: killer, cause: "killed", ...over });
    return e!.id;
  }
  const row = async () => (await db.select().from(kothEvents).where(eq(kothEvents.id, rowId)))[0]!;
  const ready = async () => {
    // An event past the window end, and the kills cursor past it: ingest has caught up.
    const id = await kill("z", "y", "2026-10-03T22:20:00Z", null);
    await writeCursor(db, KILLS_CONSUMER, id);
  };

  it("the window runs from the opening restart to the closing one", async () => {
    expect(await kothWindow(db, await row())).toEqual({ from: at("2026-10-03T20:00:04Z"), to: at("2026-10-03T22:00:04Z") });
  });

  // ⚠️ Spec §6: a catching-up bot must not score a half-ingested window.
  it("is not ready before the settle time, nor before the kills cursor passes the end", async () => {
    expect(await scoringReady(db, await row(), at("2026-10-03T22:05:00Z"))).toBe(false);
    expect(await scoringReady(db, await row(), at("2026-10-03T22:30:00Z"))).toBe(false); // no cursor yet
    await ready();
    expect(await scoringReady(db, await row(), at("2026-10-03T22:30:00Z"))).toBe(true);
  });

  it("counts victim-in-zone kills by out-of-zone killers; drops friendly fire, Hub and unplaced kills", async () => {
    await kill("a", "v1", "2026-10-03T20:10:00Z", { x: HILL.x + 499, z: HILL.z });
    await kill("a", "v2", "2026-10-03T20:11:00Z", { x: HILL.x + 501, z: HILL.z });
    await kill("b", "v3", "2026-10-03T20:12:00Z", HILL, { friendlyFire: true });
    await kill("b", "v4", "2026-10-03T20:13:00Z", HILL, { atHub: true });
    await kill("c", "v5", "2026-10-03T20:14:00Z", null);
    await kill("d", "v6", "2026-10-03T19:59:00Z", HILL); // before the window
    const r = await kothKills(db, await row(), await kothWindow(db, await row()));
    expect(r.kills.map((k) => k.killerDayzId)).toEqual(["a"]);
    expect(r.dropped).toBe(1);
  });

  // ⚠️ A credited kill cites the bare `player.died` event, never a `player.killed` one;
  // its position comes from the died payload's victimPos (FI1), or it is never placed.
  it("counts a credited (finished) kill whose bare death was on the hill", async () => {
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.died", occurredAt: at("2026-10-03T20:15:00Z"),
      payload: { victimDayzId: "v9", victimGamertag: "V", cause: "died", entity: null, water: null, energy: null, bleedSources: null, victimPos: { x: HILL.x + 10, y: 100, z: HILL.z } } }).returning();
    await db.insert(kills).values({ serverId, eventId: e!.id, occurredAt: at("2026-10-03T20:15:00Z"), victimDayzId: "v9", killerDayzId: "f", cause: "finished" });
    const r = await kothKills(db, await row(), await kothWindow(db, await row()));
    expect(r.kills.map((k) => k.killerDayzId)).toEqual(["f"]);
    expect(r.dropped).toBe(0);
  });

  it("awards the top LINKED player once, even when run twice", async () => {
    await db.insert(players).values([
      { dayzId: "u", gamertag: "Unlinked", firstSeenAt: SLOT, lastSeenAt: SLOT },
      { dayzId: "l", gamertag: "Linked", firstSeenAt: SLOT, lastSeenAt: SLOT },
    ]);
    await db.insert(identityLinks).values({ discordId: "555", dayzId: "l", gamertag: "Linked", verifiedAt: SLOT });
    await kill("u", "v1", "2026-10-03T20:10:00Z", HILL);
    await kill("u", "v2", "2026-10-03T20:11:00Z", HILL);
    await kill("l", "v3", "2026-10-03T20:12:00Z", HILL);
    await ready();
    const opts = { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" };
    const [a, b] = await Promise.all([scoreAndAward(db, rowId, opts), scoreAndAward(db, rowId, opts)]);
    expect([a, b].sort()).toEqual(["awarded", "skipped"]);
    const grants = await db.select().from(awardGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ discordId: "555", awardKey: "plate-carrier", grantedByDiscordId: "admin" });
    const saved = await row();
    expect(saved.state).toBe("awarded");
    expect(saved.results?.topKiller?.gamertag).toBe("Unlinked");
    expect(saved.results?.winner?.gamertag).toBe("Linked");
  });

  it("no counting kills → no_winner, no grant", async () => {
    await ready();
    expect(await scoreAndAward(db, rowId, { now: at("2026-10-03T22:30:00Z"), siteBaseUrl: "https://x" })).toBe("no_winner");
    expect(await db.select().from(awardGrants)).toHaveLength(0);
  });
});
