import type { ClanRef, StoryContext } from "../story/types.js";
import { isRedactedAlias } from "../engine/audio/redactedSpeech.js";

/**
 * Every speakable name in the context: gamertags, clan names and clan tags, in first-seen
 * order, de-duplicated. Redacted aliases (spec §7.3) go to `aliases`, never `names`, so the
 * caller can keep them away from the pronunciation model and the store. This replaces KOTH's
 * `showGamertags` (weekly-board tags plus the season kills leader).
 *
 * Airdrops carry only places, so they contribute nothing. The previous episode's storyline
 * players and clans are included: the script may call back to them.
 */
export function collectNames(ctx: StoryContext): { names: string[]; aliases: string[] } {
  const seen = new Set<string>();
  const names: string[] = [];
  const aliases: string[] = [];
  const add = (s: string | null | undefined) => {
    if (typeof s !== "string" || !s || seen.has(s)) return;
    seen.add(s);
    (isRedactedAlias(s) ? aliases : names).push(s);
  };
  const addClan = (c: ClanRef | null | undefined) => {
    if (!c) return;
    add(c.name);
    add(c.tag);
  };

  addClan(ctx.week.alpha);
  for (const c of ctx.clans) addClan(c);
  for (const r of ctx.raids) {
    add(r.raider);
    addClan(r.raiderClan);
    addClan(r.victimClan);
  }
  for (const e of ctx.flagEvents) addClan(e.clan);
  for (const f of ctx.friendlyFire) {
    addClan(f.clan);
    add(f.killer);
    add(f.victim);
  }
  for (const b of ctx.clanBeefs) {
    addClan(b.killerClan);
    addClan(b.victimClan);
  }
  for (const p of [...ctx.players.topKillers, ...ctx.players.mostDeaths]) {
    add(p.gamertag);
    addClan(p.clan);
  }
  for (const s of ctx.players.longestShots) {
    add(s.gamertag);
    addClan(s.clan);
    add(s.victim);
  }
  for (const d of ctx.players.oddDeaths) add(d.gamertag);
  for (const b of ctx.bounties) {
    add(b.target);
    add(b.claimer);
  }
  for (const k of ctx.koth) {
    add(k.winner);
    for (const t of k.top) add(t.gamertag);
  }
  for (const s of ctx.previous?.storylines ?? []) {
    for (const p of s.players) add(p);
    for (const c of s.clans) add(c);
  }
  return { names, aliases };
}
