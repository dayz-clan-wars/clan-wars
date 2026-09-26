import type { ChatFn } from "../llm/openrouter.js";
import { pronounceGamertags, resolvePronouncer } from "./pronounce.js";
import type { PronunciationRow, PronunciationStore } from "./pronunciationStore.js";
import { isRedactedAlias, redactedSpokenForms } from "./redactedSpeech.js";

/**
 * Resolve a per-tag pronouncer backed by the persistent cache. Order: override -> cache(∪fresh)
 * -> speakableName. Generates only tags absent from both overrides and the cache, persists them,
 * and degrades to the cache + speakableName on any LLM failure (never throws). A redacted alias
 * (spec §7.3) never reaches the LLM and is never written to the store; it resolves to its
 * `redactedSpokenForms` line instead.
 */
export async function resolveCachedPronouncer(o: {
  store: PronunciationStore;
  names: string[];
  overrides: Record<string, string>;
  chat: ChatFn;
  model: string;
}): Promise<(name: string) => string> {
  const list = [...new Set((o.names ?? []).filter((t) => typeof t === "string" && t))];
  const redacted = list.filter((t) => isRedactedAlias(t));
  const spoken = redactedSpokenForms(redacted);
  const speakable = list.filter((t) => !isRedactedAlias(t));

  const cached = await o.store.get(speakable);
  const needLlm = speakable.filter((t) => !(t in o.overrides) && !(t in cached));

  let fresh: Record<string, string> = {};
  try {
    fresh = await pronounceGamertags(needLlm, { chat: o.chat, model: o.model });
  } catch (e) {
    console.error(`[pronounce] generation failed: ${(e as Error).message}`);
  }

  const rows: PronunciationRow[] = [];
  for (const [text, s] of Object.entries(fresh)) rows.push({ text, spoken: s, source: "llm" });
  for (const [text, s] of Object.entries(o.overrides)) {
    if (speakable.includes(text) && !(text in cached)) rows.push({ text, spoken: s, source: "override" });
  }
  if (rows.length) await o.store.insertMissing(rows);

  return resolvePronouncer({ overrides: o.overrides, llmMap: { ...cached, ...fresh, ...spoken } });
}
