import type { StoryContext } from "../story/types.js";
import { SYSTEM_PROMPT } from "./system.js";

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/**
 * ⚠️ The model swapped killer and victim on a friendly-fire pair even though the fields
 * say `killer` and `victim` (S01E01 said RonaldRaygun552 was shot by the clan-mate he
 * shot). Every directional kill record gets a plain `what` sentence, built here from the
 * already-screened context so a redacted name can only appear as its alias.
 */
export function withKillSentences(context: StoryContext): StoryContext {
  return {
    ...context,
    friendlyFire: context.friendlyFire.map((f) => ({
      ...f,
      what: `${f.killer} killed their own clan-mate ${f.victim} ${times(f.count)}. ${f.killer} is the killer; ${f.victim} is the one who died.`,
    })),
    clanBeefs: context.clanBeefs.map((b) => ({
      ...b,
      what: `Players from ${b.killerClan.name} killed players from ${b.victimClan.name} ${times(b.kills)}.`,
    })),
    players: {
      ...context.players,
      longestShots: context.players.longestShots.map((s) => ({
        ...s,
        what: `${s.gamertag} killed ${s.victim} from ${s.metres} metres${s.weapon ? ` with a ${s.weapon}` : ""}.`,
      })),
    },
  };
}

/**
 * ⚠️ The model totalled friendly fire itself and got it wrong (S01E02 said SNA killed each
 * other sixteen times; the pairs add up to 22), despite the rule against totalling. The
 * per-clan totals are handed over ready-made so there is nothing left to add up.
 */
export function friendlyFireByClan(context: StoryContext) {
  const byClan = new Map<string, { clan: string; kills: number; pairs: number }>();
  for (const f of context.friendlyFire) {
    const t = byClan.get(f.clan.name) ?? { clan: f.clan.name, kills: 0, pairs: 0 };
    t.kills += f.count;
    t.pairs += 1;
    byClan.set(f.clan.name, t);
  }
  return [...byClan.values()]
    .sort((a, b) => b.kills - a.kills)
    .map((t) => ({ ...t, what: `${t.clan} players killed their own clan-mates ${times(t.kills)} this week, across ${t.pairs} killer-and-victim ${t.pairs === 1 ? "pairing" : "pairings"}.` }));
}

/**
 * ⚠️ The context goes in as one JSON document, never spliced into prose: every player
 * string stays a quoted JSON value, which is half of the prompt-injection defence
 * (spec §6.4). `PLAYER_TEXT` in the system prompt is the other half.
 */
export function buildShowPrompt(context: StoryContext): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: `Write this week's episode from this data:\n${JSON.stringify({ ...withKillSentences(context), friendlyFireByClan: friendlyFireByClan(context) })}` };
}
