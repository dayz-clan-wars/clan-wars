import type { LiveHitRun, LiveKill, LiveLongRange, LiveStreak } from "@factions/domain";
import type { KillFeedItem } from "./kill-feed-embed.js";
import type { HitFeedItem } from "./hit-feed-embed.js";
import type { KillstreakFeedItem } from "./killstreak-feed-embed.js";
import type { LongRangeFeedItem } from "./long-range-feed-embed.js";

/**
 * A feed store's item as the plain, frozen payload the shared copy reads and
 * `feed_entries` stores. Drops the cursor id and the store's decline flags;
 * never adds a field the item does not already carry (no positions).
 */
export const toLiveKill = (i: KillFeedItem): LiveKill => ({
  occurredAt: i.occurredAt.toISOString(), killer: i.killer, victim: i.victim, weapon: i.weapon, distanceM: i.distanceM,
  friendlyFire: i.friendlyFire, atHub: i.atHub, cause: i.cause, tally: i.tally, hits: i.hits,
});

export const toLiveHitRun = (i: HitFeedItem): LiveHitRun => ({
  occurredAt: i.occurredAt.toISOString(), startedAt: i.startedAt.toISOString(), attacker: i.attacker, victim: i.victim,
  weapon: i.weapon, friendlyFire: i.friendlyFire, hits: i.hits, totalDamage: i.totalDamage, victimHpAfter: i.victimHpAfter,
});

export const toLiveStreak = (i: KillstreakFeedItem): LiveStreak => ({
  occurredAt: i.occurredAt.toISOString(), startedAt: i.startedAt.toISOString(), killer: i.killer, streak: i.streak ?? 0, victims: i.victims,
});

export const toLiveLongRange = (i: LongRangeFeedItem): LiveLongRange => ({
  occurredAt: i.occurredAt.toISOString(), killer: i.killer, victim: i.victim, weapon: i.weapon, distanceM: i.distanceM,
  friendlyFire: i.friendlyFire, personalBest: i.personalBest, seasonRank: i.seasonRank, season: i.season,
});
