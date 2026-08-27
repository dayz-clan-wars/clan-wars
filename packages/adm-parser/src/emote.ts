import { parseIdentity } from "./identity.js";

export type EmotePerformed = {
  gamertag: string;
  dayzId: string;
  emote: string;
  item: string | null;
};

/**
 * `performed EmoteSalute` / `performed EmoteSuicide with SteakKnife`.
 *
 * Anchored at `performed ` rather than reusing the identity prefix, so the
 * `(DEAD)` marker and gamertags containing `)` are handled by parseIdentity
 * — the one place that logic lives.
 */
const EMOTE_RE = /\bperformed (Emote[A-Za-z0-9]+)(?: with (.+?))?\s*$/u;

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
