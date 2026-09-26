import { blocklistHit } from "./blocklist.js";
import type { Moderate } from "./moderate.js";
import type { ScreeningStore, Verdict } from "./store.js";

/**
 * A verdict for every distinct string (spec §7.1). Order of authority:
 * an operator row, then the blocklist as it is TODAY, then a cached moderator verdict,
 * then one batched moderator call for everything left.
 *
 * ⚠️ Throws if the moderator fails. The caller must treat that as "screening did not
 * run", never as "everything passed".
 */
export async function screenTexts(texts: string[], deps: { store: ScreeningStore; moderate: Moderate }): Promise<Map<string, Verdict>> {
  const unique = [...new Set(texts)];
  const cached = await deps.store.get(unique);
  const out = new Map<string, Verdict>();
  const ask: string[] = [];

  for (const t of unique) {
    const c = cached.get(t);
    if (c?.source === "operator") { out.set(t, c); continue; }
    const hit = blocklistHit(t);
    if (hit !== null) {
      const v: Verdict = { verdict: "block", source: "blocklist", reason: `blocklist: ${hit}` };
      out.set(t, v);
      await deps.store.put(t, v);
      continue;
    }
    // A cached blocklist verdict the blocklist no longer makes is stale: ask again.
    if (c && c.source !== "blocklist") { out.set(t, c); continue; }
    ask.push(t);
  }

  const results = await deps.moderate(ask);
  for (let i = 0; i < ask.length; i++) {
    const r = results[i]!;
    const v: Verdict = { verdict: r.block ? "block" : "allow", source: "llm", reason: r.reason === "" ? null : r.reason };
    out.set(ask[i]!, v);
    await deps.store.put(ask[i]!, v);
  }
  return out;
}
