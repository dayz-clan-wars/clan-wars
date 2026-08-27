import { parseIdentity } from "./identity.js";

export type EmotePerformed = {
  gamertag: string;
  dayzId: string;
  emote: string;
  /**
   * The "with <item>" suffix, e.g. EmoteSuicide with SteakKnife.
   *
   * ⚠️ Captured and persisted, but read by NOTHING today. It is free text from
   * a log line whose earlier fields are attacker-influenced, so any future
   * consumer must validate it rather than trust it.
   */
  item: string | null;
};

/**
 * `performed EmoteSalute` / `performed EmoteSuicide with SteakKnife`.
 *
 * CRITICAL: Anchored to the identity block `(id=...)` rather than searching from
 * line start. The gamertag is attacker-controlled and can contain the literal text
 * `performed` and `with` — if unanchored, a malicious name like
 * `x performed EmoteSalute with y` on the real emote line would match at the wrong
 * position and inject fabricated events or leak coordinates into the item field.
 *
 * The `(DEAD)` marker and gamertags containing `)` are handled by parseIdentity
 * — the one place that logic lives.
 */
const EMOTE_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*performed (Emote[A-Za-z0-9]+)(?: with (.+?))?\s*$/u;

export function parseEmote(raw: string): EmotePerformed | null {
  const m = EMOTE_RE.exec(raw);
  if (!m) return null;

  const who = parseIdentity(raw);
  // An emote with no identity cannot bind a challenge. Drop it rather than
  // emit an event whose whole purpose is the UID it does not have.
  if (!who) return null;

  return {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    emote: m[1]!,
    item: m[2] != null ? m[2].trim() : null,
  };
}
