import { RECENT_HIT_WINDOW_S } from "./death-verdict.js";

/** The default quiet gap that closes an engagement. Overridden by `HIT_BURST_WINDOW_S`. */
export const DEFAULT_HIT_BURST_WINDOW_S = 60;

/** One `player.hit` event, flattened. Exactly what the feed needs; no coordinates, ever. */
export type HitInput = {
  eventId: number;
  /** ⚠️ Part of the engagement's identity — see `keyOf`. Multi-server is live, and a dayzId is not scoped to one. */
  serverId: number;
  occurredAt: Date;
  attackerType: "player" | "infected" | "environment";
  attackerDayzId: string | null;
  victimDayzId: string;
  weapon: string | null;
  damage: number | null;
  bodyPart: string | null;
  distanceM: number | null;
  /** The victim's HP AFTER the hit. */
  victimHp: number | null;
};

/** A run of hits sharing (server, attacker, victim, weapon). `closed` means no further hit can join it. */
export type HitEngagement = {
  firstEventId: number;
  lastEventId: number;
  startedAt: Date;
  endedAt: Date;
  serverId: number;
  attackerDayzId: string;
  victimDayzId: string;
  weapon: string | null;
  /** Oldest first. */
  hits: HitInput[];
  closed: boolean;
};

/** PvP only: another player, named by id. Infected, environment and self-inflicted are not fights. */
function isPvp(h: HitInput): boolean {
  return h.attackerType === "player" && h.attackerDayzId !== null && h.attackerDayzId !== h.victimDayzId;
}

/**
 * `weapon` is part of the key and may be null, which must NOT collide with a
 * weapon literally named "null" — hence the length prefix rather than a join.
 *
 * ⚠️ `serverId` is part of the key too. A dayzId is a game-account identity,
 * not scoped to one server; without the server term, the same pair fighting
 * on two servers at once would merge into a single cross-server engagement.
 */
function keyOf(h: HitInput): string {
  const w = h.weapon === null ? "-" : `${h.weapon.length}:${h.weapon}`;
  return `${h.serverId}|${h.attackerDayzId}|${h.victimDayzId}|${w}`;
}

/**
 * Group PvP hits into engagements.
 *
 * Pure: `frontier` is the caller's notion of "now", and there is no clock here.
 *
 * ⚠️ An engagement closes only when the frontier is
 * `max(windowS, RECENT_HIT_WINDOW_S)` past its last hit. Two separate reasons,
 * both necessary:
 *
 *   - `windowS` is the quiet gap that defines the burst.
 *   - `RECENT_HIT_WINDOW_S` (120) is how far back `kills-tick`'s `verdictOf`
 *     looks to credit a *finished* death. A burst quiet for 60s can still be
 *     claimed by a death 90s later; posting it at 60s would put the same fight
 *     in #hit-feed and #kill-feed.
 *
 * Do not collapse the two into one constant. Raising `windowS` past 120 widens
 * both the burst and the delay; lowering it below 120 widens neither, because
 * the settle floor binds.
 *
 * ⚠️ `frontier` must be the INGEST frontier, not `Date.now()`. The ADM poller
 * ingests in file-sized chunks; against a wall clock, a poller ten minutes
 * behind makes every open engagement look quiet and the feed closes fights
 * that are still being fought.
 */
export function groupHitBursts(hits: HitInput[], opts: { frontier: Date; windowS: number }): HitEngagement[] {
  const settleMs = Math.max(opts.windowS, RECENT_HIT_WINDOW_S) * 1000;
  const windowMs = opts.windowS * 1000;

  const open = new Map<string, HitEngagement>();
  const out: HitEngagement[] = [];

  for (const h of [...hits].sort((a, b) => a.eventId - b.eventId)) {
    if (!isPvp(h)) continue;
    const key = keyOf(h);
    const current = open.get(key);
    if (current && h.occurredAt.getTime() - current.endedAt.getTime() <= windowMs) {
      current.hits.push(h);
      current.lastEventId = h.eventId;
      current.endedAt = h.occurredAt;
      continue;
    }
    const started: HitEngagement = {
      firstEventId: h.eventId, lastEventId: h.eventId,
      startedAt: h.occurredAt, endedAt: h.occurredAt,
      serverId: h.serverId, attackerDayzId: h.attackerDayzId!, victimDayzId: h.victimDayzId, weapon: h.weapon,
      hits: [h], closed: false,
    };
    open.set(key, started);
    out.push(started);
  }

  for (const e of out) e.closed = opts.frontier.getTime() - e.endedAt.getTime() >= settleMs;
  return out;
}
