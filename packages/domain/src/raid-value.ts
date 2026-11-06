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

export function clanValue(clan: ValuedClan, facts: RaidFact[], at: Date, excludeRaidId?: number): number {
  if (at.getTime() < clan.activatedAt.getTime() + NEW_CLAN_WORTHLESS_MS) return 0;
  const { heat, hits } = windows(clan, facts, at, excludeRaidId);
  let value = RAID_VALUE_BASE;
  for (const d of heat) value += RAID_HEAT * (1 - d / RAID_HEAT_FADE_MS);
  for (const d of hits) value *= 0.5 + (0.5 * d) / RAID_HIT_FADE_MS;
  return value;
}

export function raidPoints(value: number, online: boolean): number {
  return Math.round(value * (online ? RAID_ONLINE_MULT : RAID_OFFLINE_MULT));
}

export function valueReasons(clan: ValuedClan, facts: RaidFact[], at: Date): ValueReasons {
  const { heat, hits } = windows(clan, facts, at);
  const until = clan.activatedAt.getTime() + NEW_CLAN_WORTHLESS_MS;
  return { recentRaids: heat.length, hitsThisWeek: hits.length, newUntil: until > at.getTime() ? new Date(until) : null };
}
