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
 * ⚠️ The context goes in as one JSON document, never spliced into prose: every player
 * string stays a quoted JSON value, which is half of the prompt-injection defence
 * (spec §6.4). `PLAYER_TEXT` in the system prompt is the other half.
 */
export function buildShowPrompt(context: StoryContext): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: `Write this week's episode from this data:\n${JSON.stringify(withKillSentences(context))}` };
}
