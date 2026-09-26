import type { ChatFn } from "../llm/openrouter.js";
import { parseJsonObject } from "../llm/openrouter.js";
import { speakableName } from "./speakableName.js";

const SYSTEM =
  "You convert DayZ gamertags into how a text-to-speech voice should read them aloud. " +
  "Apply these rules to each tag: (1) strip decorative wrappers like xX...Xx; " +
  "(2) drop trailing runs of digits (Xbox appends random numbers); " +
  "(3) expand leetspeak — digits used as letters (4->a, 3->e, 1->i, 0->o, 5->s, 7->t); " +
  "(4) split joined or CamelCase words so they read naturally. " +
  "Then choose the spoken form per tag (hybrid): for an ordinary name or word, return it as plain natural words; " +
  "only when the tag is unusual or ambiguous, return a phonetic respelling with hyphenated syllables and the " +
  "stressed syllable in CAPS (for example BEE-zee or kuh-RAH-jus). Keep each one short and natural. " +
  "Reply ONLY with a JSON object mapping each input tag (verbatim, as the key) to its spoken form.";

/**
 * One cheap LLM call mapping gamertags -> spoken form. Throws when `chat` throws, so the
 * caller can fall back to speakableName. Returns {} for empty input (no call).
 */
export async function pronounceGamertags(tags: string[], o: { chat: ChatFn; model: string }): Promise<Record<string, string>> {
  const list = [...new Set((tags ?? []).filter((t) => typeof t === "string" && t))];
  if (!list.length) return {};
  const content = await o.chat({
    model: o.model,
    responseFormat: "json_object",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(list) },
    ],
  });
  const map = parseJsonObject(content) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const t of list) {
    const spoken = map[t];
    if (typeof spoken === "string" && spoken.trim()) out[t] = spoken.trim();
  }
  return out;
}

/** Per-tag resolver: override map wins, then the LLM map, then deterministic speakableName. */
export function resolvePronouncer(o: { overrides?: Record<string, string>; llmMap?: Record<string, string> } = {}): (tag: string) => string {
  const overrides = o.overrides ?? {};
  const llmMap = o.llmMap ?? {};
  return (tag: string) => overrides[tag] ?? llmMap[tag] ?? speakableName(tag);
}
