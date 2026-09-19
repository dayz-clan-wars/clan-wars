import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
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
  /**
   * Where the player stood, NORMALISED: a `Vec3` of `{x, y, z}` whose **y is
   * always altitude**, whatever order the ADM line spelled it in —
   * `parsePlayerPos` does that conversion, and it is the only place it
   * happens. Null when the line carries no position block.
   *
   * ⚠️ Every consumer writes this straight across (`pos.y` → an altitude
   * column, as `declarations.y` and `booster_kits.pos_y` are). There is no
   * second reordering to apply anywhere downstream. Adding one would swap y
   * and z and bury every kit underground.
   *
   * ⚠️ Read by the booster kit placement challenge, which writes it to the
   * map. parsePlayerPos is anchored INSIDE the identity parenthetical for
   * exactly this reason: unanchored, a gamertag carrying a pos block moves
   * someone else's kit.
   */
  pos: Vec3 | null;
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
    pos: parsePlayerPos(raw),
  };
}
