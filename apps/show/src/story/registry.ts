import type { ClanRef } from "./types.js";

export type TextKind = "gamertag" | "clanName" | "clanTag" | "pitch" | "bountyReason";

/** Spec §6.4. A capped string is what the context carries AND what screening sees. */
export const TEXT_CAPS: Record<TextKind, number> = { gamertag: 32, clanName: 32, clanTag: 12, pitch: 200, bountyReason: 100 };

export type TextEntry = { text: string; kinds: TextKind[]; tagOf: string | null };

/**
 * Every string a player wrote that reaches the story context, registered at the one
 * place it is read (spec §5.1). Screening and redaction work from this list, so a
 * reader that forgets to register a string leaves it unscreened: route every
 * player-written column through one of these methods, and never put one in the
 * context any other way.
 */
export class PlayerTexts {
  private readonly map = new Map<string, { kinds: Set<TextKind>; tagOf: string | null }>();

  private add(raw: string, kind: TextKind, tagOf: string | null = null): string {
    const text = raw.slice(0, TEXT_CAPS[kind]);
    const e = this.map.get(text) ?? { kinds: new Set<TextKind>(), tagOf: null };
    e.kinds.add(kind);
    if (tagOf !== null) e.tagOf = tagOf;
    this.map.set(text, e);
    return text;
  }

  gamertag(s: string): string { return this.add(s, "gamertag"); }
  clanTag(s: string): string { return this.add(s, "clanTag"); }
  clan(name: string, tag: string): ClanRef {
    const t = this.clanTag(tag);
    return { name: this.add(name, "clanName", t), tag: t };
  }
  pitch(s: string): string { return this.add(s, "pitch"); }
  bountyReason(s: string): string { return this.add(s, "bountyReason"); }

  entries(): TextEntry[] {
    return [...this.map].map(([text, e]) => ({ text, kinds: [...e.kinds].sort(), tagOf: e.tagOf }));
  }
}
