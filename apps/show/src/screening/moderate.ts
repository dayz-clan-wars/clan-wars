import { parseJsonObject, type ChatFn } from "../engine/llm/openrouter.js";

export type ModerationResult = { block: boolean; reason: string };
export type Moderate = (texts: string[]) => Promise<ModerationResult[]>;

export class ModerationError extends Error {}

export const MODERATION_SYSTEM = [
  "You screen text for a comedy show about a DayZ game server. The show is published on YouTube, Facebook and Discord.",
  "Each item is either text a player wrote (a gamertag, a clan name or tag, a clan's recruiting pitch, a bounty reason) or a finished comedy script.",
  "Block an item only if a reasonable audience would read it as one of these:",
  "a slur, or hateful language about a group of people;",
  "a reference to Nazis, white supremacy, or another extremist or terrorist group, including coded forms (numbers such as 1488, abbreviations, misspellings, lookalike letters);",
  "explicit sexual content;",
  "a threat against a real person.",
  "Do not block crude or juvenile humour, mild innuendo, or double meanings (a rooster-themed clan called The Cocks is fine).",
  "Do not block violence inside the game (killing, raiding, weapons, looting), mild profanity, or names that just contain numbers.",
  "Reply with JSON only, exactly one result per input item:",
  '{"results":[{"i":<item index>,"block":<true or false>,"reason":"<short reason, empty when allowed>"}]}',
].join("\n");

/**
 * One batched moderation call (spec §7.1, §7.2).
 *
 * ⚠️ Fails closed. A reply that is not JSON, has no `results`, or skips any item throws
 * `ModerationError`. There is no default verdict: an item the moderator did not rule on
 * is not an item it allowed.
 */
export function createModerator(deps: { chat: ChatFn; model: string }): Moderate {
  return async (texts) => {
    if (texts.length === 0) return [];
    const content = await deps.chat({
      model: deps.model,
      responseFormat: "json_object",
      temperature: 0,
      messages: [
        { role: "system", content: MODERATION_SYSTEM },
        { role: "user", content: JSON.stringify(texts.map((text, i) => ({ i, text }))) },
      ],
    });
    let parsed: unknown;
    try { parsed = parseJsonObject(content); } catch { throw new ModerationError("moderation reply was not JSON"); }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new ModerationError("moderation reply has no results array");
    const out: (ModerationResult | undefined)[] = texts.map(() => undefined);
    for (const r of results) {
      const i = (r as { i?: unknown }).i;
      const block = (r as { block?: unknown }).block;
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= texts.length) continue;
      if (typeof block !== "boolean") throw new ModerationError(`moderation result ${i} has no boolean verdict`);
      out[i] = { block, reason: String((r as { reason?: unknown }).reason ?? "") };
    }
    const missing = out.findIndex((x) => x === undefined);
    if (missing !== -1) throw new ModerationError(`moderation skipped item ${missing}`);
    return out as ModerationResult[];
  };
}
