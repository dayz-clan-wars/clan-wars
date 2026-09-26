import type { StoryContext } from "../story/types.js";
import type { TextEntry, TextKind } from "../story/registry.js";
import type { Verdict } from "./store.js";

export type Redaction = { text: string; kinds: TextKind[]; replacement: string | null; reason: string | null; source: Verdict["source"] };
export type ScreeningReport = { redactions: Redaction[] };

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Apply the screening verdicts to the context (spec §7.3):
 * a blocked gamertag becomes REDACTED_PLAYER_n; a blocked tag becomes REDACTED_CLAN_n;
 * a blocked clan name falls back to its tag (or the tag's alias when that is blocked too); a blocked pitch or bounty
 * reason is dropped (null). Aliases are numbered in registry order, so they are stable
 * within an episode.
 *
 * Every string VALUE in the context that equals a blocked text is replaced. Inside
 * `previous` (sentences the model wrote last week) names are also replaced where they
 * appear inside a longer string, since a name there is embedded in prose. That in-prose
 * match ignores case, since last week's storyline text is free-form and a blocked name
 * can resurface there in any casing.
 */
export function redactContext(context: StoryContext, entries: TextEntry[], verdicts: Map<string, Verdict>): {
  context: StoryContext; report: ScreeningReport; blocked: string[];
} {
  const blockedEntries = entries.filter((e) => verdicts.get(e.text)?.verdict === "block");
  const replace = new Map<string, string | null>();
  let players = 0;
  let clans = 0;

  // Tags first: a clan name can only fall back to its tag if the tag itself is clean.
  for (const e of blockedEntries) {
    if (e.kinds.includes("clanTag")) replace.set(e.text, `REDACTED_CLAN_${++clans}`);
  }
  for (const e of blockedEntries) {
    if (replace.has(e.text)) continue;
    if (e.kinds.includes("gamertag")) replace.set(e.text, `REDACTED_PLAYER_${++players}`);
    else if (e.kinds.includes("clanName")) replace.set(e.text, e.tagOf === null ? `REDACTED_CLAN_${++clans}` : (replace.get(e.tagOf) ?? e.tagOf));
    else replace.set(e.text, null);
  }

  const names = [...replace].filter((kv): kv is [string, string] => kv[1] !== null).sort((a, b) => b[0].length - a[0].length);
  const inProse = (s: string) =>
    names.reduce((acc, [from, to]) => acc.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(from)}(?![A-Za-z0-9])`, "giu"), to), s);

  const walk = (v: unknown, prose: boolean): unknown => {
    if (typeof v === "string") return replace.has(v) ? replace.get(v)! : prose ? inProse(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, prose));
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, prose || k === "previous")]));
    }
    return v;
  };

  return {
    context: walk(context, false) as StoryContext,
    report: {
      redactions: blockedEntries.map((e) => {
        const v = verdicts.get(e.text)!;
        return { text: e.text, kinds: e.kinds, replacement: replace.get(e.text) ?? null, reason: v.reason, source: v.source };
      }),
    },
    blocked: blockedEntries.map((e) => e.text),
  };
}
