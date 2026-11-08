import {
  NEW_CLAN_WORTHLESS_MS, RAID_HEAT, RAID_HEAT_FADE_MS, RAID_HIT_FADE_MS,
  RAID_OFFLINE_MULT, RAID_ONLINE_MULT, RAID_VALUE_BASE,
} from "./rules";

export type RaidFact = { id: number; at: Date; raiderFactionId: number | null; victimFactionId: number };
export type ValuedClan = { id: number; activatedAt: Date };
export type ValueReasons = { recentRaids: number; hitsThisWeek: number; newUntil: Date | null };

/**
 * Facts strictly before `at`. ⚠️ A same-instant fact counts only with a smaller id than
 * excludeRaidId: the rescore replays with every row present and must match the live consumer,
 * which saw only earlier rows.
 */
function earlier(facts: RaidFact[], at: Date, excludeRaidId?: number): RaidFact[] {
  const t = at.getTime();
  return facts.filter((f) => {
    const ft = f.at.getTime();
    return ft < t || (ft === t && excludeRaidId !== undefined && f.id < excludeRaidId);
  });
}

/** Facts where the clan raided (heat) or was raided by a real clan (hits), inside their windows. */
function windows(clan: ValuedClan, facts: RaidFact[], at: Date, excludeRaidId?: number) {
  const t = at.getTime();
  const heat: number[] = [];
  const hits: number[] = [];
  for (const f of earlier(facts, at, excludeRaidId)) {
    const d = t - f.at.getTime();
    // ⚠️ Solo hits (null raider) are not raids on a clan, so they never halve value.
    if (f.raiderFactionId === clan.id && d < RAID_HEAT_FADE_MS) heat.push(d);
    if (f.victimFactionId === clan.id && f.raiderFactionId !== null && d < RAID_HIT_FADE_MS) hits.push(d);
  }
  return { heat, hits };
}

/**
 * A clan's value, taken apart: what the raid notice prints line by line.
 * `value` is `(base + heat) × hitFactor`, or 0 while the clan is new
 * (`worthlessUntil` set). The parts are still filled in for a new clan, so a
 * caller can say what it will be worth once it starts counting.
 */
export type ValueBreakdown = { base: number; heat: number; hitFactor: number; value: number; worthlessUntil: Date | null };

export function valueBreakdown(clan: ValuedClan, facts: RaidFact[], at: Date, excludeRaidId?: number): ValueBreakdown {
  const { heat, hits } = windows(clan, facts, at, excludeRaidId);
  let heatSum = 0;
  for (const d of heat) heatSum += RAID_HEAT * (1 - d / RAID_HEAT_FADE_MS);
  let hitFactor = 1;
  for (const d of hits) hitFactor *= 0.5 + (0.5 * d) / RAID_HIT_FADE_MS;
  const until = clan.activatedAt.getTime() + NEW_CLAN_WORTHLESS_MS;
  const worthless = at.getTime() < until;
  return {
    base: RAID_VALUE_BASE, heat: heatSum, hitFactor,
    value: worthless ? 0 : (RAID_VALUE_BASE + heatSum) * hitFactor,
    worthlessUntil: worthless ? new Date(until) : null,
  };
}

export function clanValue(clan: ValuedClan, facts: RaidFact[], at: Date, excludeRaidId?: number): number {
  return valueBreakdown(clan, facts, at, excludeRaidId).value;
}

/**
 * Only an ACTIVE raiding clan scores. A dormant or reserved clan's raid is
 * still a real raid row, so it still adds heat to the raider's own value and
 * still counts as a hit on the victim: it just pays 0.
 *
 * `raiderStatus` is the clan's status as recorded on the raid row at the
 * first lower. ⚠️ Null with a clan means a row written before the rule
 * existed (status was never recorded) and prices as it always did: the
 * rescore must never zero a raid a clan was paid for under the old rules.
 */
export function raidScores(raiderFactionId: number | null, raiderStatus: string | null): boolean {
  if (raiderFactionId === null) return false;
  return raiderStatus === null || raiderStatus === "active";
}

export function raidPoints(value: number, online: boolean): number {
  return Math.round(value * (online ? RAID_ONLINE_MULT : RAID_OFFLINE_MULT));
}

export function valueReasons(clan: ValuedClan, facts: RaidFact[], at: Date): ValueReasons {
  const { heat, hits } = windows(clan, facts, at);
  const until = clan.activatedAt.getTime() + NEW_CLAN_WORTHLESS_MS;
  return { recentRaids: heat.length, hitsThisWeek: hits.length, newUntil: until > at.getTime() ? new Date(until) : null };
}
