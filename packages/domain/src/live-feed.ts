/**
 * The website's Live page (spec 2026-09-30-website-live-feeds): one tab per
 * Discord feed. The four combat feeds are stored in `feed_entries` with one of
 * these payloads, frozen at record time. Every instant is an ISO string because
 * jsonb has no timestamp type. No payload ever carries a position.
 */
export const LIVE_ENTRY_KINDS = ["kill", "hit", "killstreak", "long_range"] as const;
export type LiveEntryKind = (typeof LIVE_ENTRY_KINDS)[number];

export const LIVE_FEEDS = ["online", "kills", "hits", "streaks", "long-range", "clans", "war-log", "achievements", "bans"] as const;
export type LiveFeed = (typeof LIVE_FEEDS)[number];
export type LiveCombatFeed = "kills" | "hits" | "streaks" | "long-range";

export const LIVE_FEED_KIND: Record<LiveCombatFeed, LiveEntryKind> = {
  kills: "kill", hits: "hit", streaks: "killstreak", "long-range": "long_range",
};

export const LIVE_PAGE_SIZE = 50;

export function isLiveFeed(s: string): s is LiveFeed {
  return (LIVE_FEEDS as readonly string[]).includes(s);
}

/** One side: the gamertag, and the clan tag and flag at the moment of the entry. */
export type LiveSide = { gamertag: string; tag: string | null; texture: string | null };
export type LiveHitLine = { damage: number | null; bodyPart: string | null; weapon: string | null; distanceM: number | null };

export type LiveKill = {
  occurredAt: string;
  killer: LiveSide; victim: LiveSide;
  weapon: string | null; distanceM: number | null;
  friendlyFire: boolean; atHub: boolean; cause: string;
  tally: { killerKills: number; victimDeaths: number; season: number | null };
  hits: LiveHitLine[];
};

export type LiveHitRun = {
  occurredAt: string; startedAt: string;
  attacker: LiveSide; victim: LiveSide;
  weapon: string | null; friendlyFire: boolean;
  hits: LiveHitLine[]; totalDamage: number | null; victimHpAfter: number | null;
};

export type LiveStreak = { occurredAt: string; startedAt: string; killer: LiveSide; streak: number; victims: string[] };

export type LiveLongRange = {
  occurredAt: string;
  killer: LiveSide; victim: LiveSide;
  weapon: string | null; distanceM: number | null; friendlyFire: boolean;
  personalBest: boolean; seasonRank: number | null; season: number | null;
};

export type LivePayload = { kill: LiveKill; hit: LiveHitRun; killstreak: LiveStreak; long_range: LiveLongRange };
