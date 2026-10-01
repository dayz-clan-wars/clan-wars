import type { BanAnnouncementKind, BanReason } from "@factions/domain";
import { banLine } from "@factions/copy";
import { lineMarkdown } from "./site-links.js";

export type BanAnnouncement = {
  kind: BanAnnouncementKind;
  /** Frozen at ban time — never the player's current name. */
  gamertag: string;
  reason: BanReason;
  /** ISO string, or null for a permanent ban. */
  expiresAt: string | null;
};

/**
 * Turns one queued `ban_announcements` row into the exact line posted to the
 * public `#bans` channel. Pure — no database, no Discord client.
 *
 * ⚠️ `gamertag` is PLAYER-CONTROLLED text landing in a PUBLIC channel — this
 * is the one renderer here whose input a hostile player chooses directly.
 * The shared copy emits it as a `text` segment, which `lineMarkdown` escapes
 * with the existing `escapeMarkdown`; do not add a second escaper.
 *
 * ⚠️ Escaping markdown does NOT suppress `@everyone`/`@here` mentions — a
 * gamertag of literally "@everyone" still pings if the poster sends it with
 * mentions allowed. Mention suppression is the poster's job (Task 5), not
 * this function's; this function is not the whole defence against a hostile
 * gamertag.
 */
export function banAnnouncementText(a: BanAnnouncement): string {
  // A ban line has no links, so the site URL is unused.
  return lineMarkdown(banLine(a), "");
}
