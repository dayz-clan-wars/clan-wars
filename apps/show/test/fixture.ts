import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, admFiles, events, players, factions, factionMembers, factionEvents, seasons, seasonStandings,
  kills, playerSessions, membershipHistory, raids, defenses, bounties, kothEvents, airdropEvents, showEpisodes,
  type Database,
} from "@factions/db";

export const URL = requireTestDatabaseUrl();
/** The week under test: Monday 2026-09-21 (S01E03). */
export const MON = new Date("2026-09-21T00:00:00Z");
export const PREV_MON = new Date("2026-09-14T00:00:00Z");
export const SEASON_START = new Date("2026-09-08T00:39:17Z");
/** An instant `day` days after MON, at hh:mm UTC. Negative days reach into last week. */
export const at = (day: number, hh = 0, mm = 0) => new Date(MON.getTime() + day * 86_400_000 + hh * 3_600_000 + mm * 60_000);

// ⚠️ One client per file (see packages/roster/test/stats.test.ts): a client per test
// leaks its pool and runs the server out of connections part way through a suite.
export async function openDb(): Promise<Database> {
  const db = createClient(URL);
  await runMigrations(db);
  return db;
}

export type Fx = Awaited<ReturnType<typeof makeFixture>>;

export async function makeFixture(db: Database) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local client_min_messages = warning`);
    await tx.execute(sql`truncate table show_episodes, show_text_screening, show_pronunciations, airdrop_events, koth_events, bounties, kills, player_sessions, membership_history, defenses, season_standings, raids, faction_events, faction_members, seasons, events, raw_lines, adm_files, factions, players, servers restart identity cascade`);
  });
  const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
  const serverId = s!.id;
  const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at(-30), linesIngested: 0, complete: true }).returning();
  const admFileId = f!.id;
  let line = 0;
  const [season] = await db.insert(seasons).values({ serverId, number: 1, startedAt: SEASON_START }).returning();
  const seasonId = season!.id;

  const event = async (type: string, occurredAt: Date, payload: unknown = {}) => {
    const [ev] = await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: type as never, occurredAt, payload }).returning();
    return ev!.id;
  };
  // Real claimable textures, one per clan: holding clans may not share a flag.
  const TEXTURES = ["Flag_Bear", "Flag_Wolf", "Flag_Rooster", "Flag_Pirates", "Flag_DayZ", "Flag_Chernarus"];
  let nextTexture = 0;

  return {
    serverId, seasonId,
    event,
    player: async (dayzId: string, gamertag: string) => {
      await db.insert(players).values({ dayzId, gamertag, firstSeenAt: at(-30), lastSeenAt: at(0) }).onConflictDoNothing();
    },
    clan: async (a: { tag: string; name?: string; status?: string; pitch?: string | null }) => {
      const [row] = await db.insert(factions).values({
        serverId, name: a.name ?? a.tag, tag: a.tag, texture: TEXTURES[nextTexture++]!, status: a.status ?? "active",
        leaderDiscordId: `lead-${a.tag}`, createdAt: at(-20), activatedAt: at(-20), pitch: a.pitch ?? null,
        dormantSince: a.status === "dormant" ? at(-1) : null,
      }).returning();
      return row!.id;
    },
    /** A membership span; an open span (no `leftAt`) is also a full `faction_members` row. */
    member: async (factionId: number, dayzId: string, joinedAt = at(-20), leftAt: Date | null = null) => {
      await db.insert(membershipHistory).values({ serverId, factionId, dayzId, joinedAt, leftAt });
      if (!leftAt) {
        await db.insert(factionMembers).values({ serverId, factionId, dayzId, discordId: `disc-${dayzId}`, role: "member", joinedAt, status: "full" });
      }
    },
    session: async (a: { dayzId: string; from: Date; to: Date | null }) => {
      const eventId = await event("player.connected", a.from);
      await db.insert(playerSessions).values({
        serverId, dayzId: a.dayzId, connectedAt: a.from, connectEventId: eventId,
        disconnectedAt: a.to, closeReason: a.to ? "disconnect" : null,
      });
    },
    raid: async (a: { victim: number; raider: string; raiderClan: number | null; at: Date; points: number; weekStart?: Date }) => {
      const ev = await event("flag.lowered", a.at);
      await db.insert(raids).values({
        seasonId, serverId, victimFactionId: a.victim, raiderDayzId: a.raider, raiderFactionId: a.raiderClan,
        firstLowerEventId: ev, firstLowerAt: a.at, lastLowerAt: a.at, lastLowerEventId: ev,
        lowerCount: 1, points: a.points, victimRankAtLower: null, rankedCountAtLower: 0, weekStart: a.weekStart ?? MON,
      });
    },
    defense: async (a: { clan: number; by: string; flagDownSince: Date; at: Date }) => {
      const ev = await event("flag.raised", a.at);
      await db.insert(defenses).values({
        factionId: a.clan, seasonId, raisedByDayzId: a.by, eventId: ev, flagDownSince: a.flagDownSince, defendedAt: a.at,
        siegeSeconds: Math.round((a.at.getTime() - a.flagDownSince.getTime()) / 1000),
      });
    },
    standing: async (factionId: number, a: { points: number; raids: number }) => {
      await db.insert(seasonStandings).values({ seasonId, factionId, points: a.points, raids: a.raids });
    },
    kill: async (a: {
      at: Date; victim: string; killer: string | null; cause?: string; weapon?: string; distanceM?: number;
      victimClan?: number | null; killerClan?: number | null; friendlyFire?: boolean; atHub?: boolean;
    }) => {
      const eventId = await event(a.killer ? "player.killed" : "player.died", a.at);
      await db.insert(kills).values({
        serverId, eventId, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
        weapon: a.weapon ?? null, distanceM: a.distanceM === undefined ? null : String(a.distanceM),
        cause: a.cause ?? (a.killer ? "pvp" : "died"),
        victimFactionId: a.victimClan ?? null, killerFactionId: a.killerClan ?? null,
        friendlyFire: a.friendlyFire ?? false, atHub: a.atHub ?? false,
      });
      return eventId;
    },
    factionEvent: async (factionId: number, kind: string, occurredAt: Date, payload: unknown = {}) => {
      await db.insert(factionEvents).values({ serverId, factionId, kind: kind as never, occurredAt, payload });
    },
    bounty: async (a: { target: string; reason: string; placedAt: Date; claimedBy?: string; claimedAt?: Date; claimEventId?: number }) => {
      const claimed = a.claimedBy !== undefined;
      await db.insert(bounties).values({
        serverId, targetDayzId: a.target, reason: a.reason, placedByDiscordId: "admin", placedAt: a.placedAt,
        onlineBudgetMs: 86_400_000, deadlineAt: new Date(a.placedAt.getTime() + 30 * 86_400_000),
        status: claimed ? "claimed" : "open", closedAt: claimed ? a.claimedAt! : null,
        claimedByDayzId: a.claimedBy ?? null, claimEventId: a.claimEventId ?? null, claimedAt: a.claimedAt ?? null,
      });
    },
    // If a koth_events CHECK refuses this row, fill the column the error names (schema.ts `kothEvents`).
    koth: async (a: { location: string; slotAt: Date; top: { dayzId: string; gamertag: string; kills: number }[] }) => {
      const winner = a.top[0] ?? null;
      await db.insert(kothEvents).values({
        serverId, slotAt: a.slotAt, location: a.location, centreX: "0", centreZ: "0", state: "finished",
        results: { top: a.top, topKiller: winner, winner, droppedNoPosition: 0 },
      });
    },
    airdrop: async (a: { location: string; slotAt: Date }) => {
      await db.insert(airdropEvents).values({
        serverId, slotAt: a.slotAt, location: a.location, colour: "orange", decidedAt: a.slotAt,
        popAtDecision: 10, threshold: "10", state: "ended",
      });
    },
    episode: async (a: { weekStart: Date; episodeNumber: number; title: string | null; storylines: unknown; narrative: string | null; stage?: string }) => {
      await db.insert(showEpisodes).values({
        weekStart: a.weekStart, seasonId, seasonNumber: 1, episodeNumber: a.episodeNumber,
        stage: (a.stage ?? (a.narrative ? "scripted" : "new")) as never,
        title: a.title, storylines: a.storylines, narrative: a.narrative,
      });
    },
  };
}
