import type { StoryContext } from "../story/types.js";
import { SYSTEM_PROMPT } from "./system.js";

/**
 * ⚠️ The context goes in as one JSON document, never spliced into prose: every player
 * string stays a quoted JSON value, which is half of the prompt-injection defence
 * (spec \u00a76.4). `PLAYER_TEXT` in the system prompt is the other half.
 */
export function buildShowPrompt(context: StoryContext): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: `Write this week's episode from this data:\n${JSON.stringify(context)}` };
}
