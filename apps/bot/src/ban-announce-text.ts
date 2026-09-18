import type { BanAnnouncementKind, BanReason } from "@factions/domain";
import { escapeMarkdown } from "./kill-feed-embed.js";

export type BanAnnouncement = {
  kind: BanAnnouncementKind;
  /** Frozen at ban time — never the player's current name. */
  gamertag: string;
  reason: BanReason;
  /** ISO string, or null for a permanent ban. */
  expiresAt: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `d MMM yyyy`, UTC, from an ISO 8601 string — e.g. "8 Sep 2026". Matches
 * `notice-text.ts`'s private `formatDate` exactly (the house convention for
 * a player-facing date); that helper isn't exported, so this is a deliberate
 * duplicate of the same format, not a new one.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Turns one queued `ban_announcements` row into the exact line posted to the
 * public `#bans` channel. Pure — no database, no Discord client.
 *
 * ⚠️ `gamertag` is PLAYER-CONTROLLED text landing in a PUBLIC channel — this
 * is the one renderer here whose input a hostile player chooses directly.
 * It is escaped with the existing `escapeMarkdown` (kill-feed-embed.ts) so a
 * name containing markdown can't restyle or break the message; do not add a
 * second escaper.
 *
 * ⚠️ Escaping markdown does NOT suppress `@everyone`/`@here` mentions — a
 * gamertag of literally "@everyone" still pings if the poster sends it with
 * mentions allowed. Mention suppression is the poster's job (Task 5), not
 * this function's; this function is not the whole defence against a hostile
 * gamertag.
 */
export function banAnnouncementText(a: BanAnnouncement): string {
  const tag = escapeMarkdown(a.gamertag);

  if (a.kind === "expired") {
    return `🔓 **${tag}** unbanned — ban served.`;
  }

  if (a.kind === "lifted") {
    return a.reason === "unlinked_pc" ? `🔓 **${tag}** unbanned — account linked.` : `🔓 **${tag}** unbanned.`;
  }

  // a.kind === "applied"
  if (a.reason === "unlinked_pc") {
    return `🔨 **${tag}** banned — playing on PC without a linked account. Link your account to lift it.`;
  }
  return a.expiresAt === null
    ? `🔨 **${tag}** banned permanently — base-zone enforcement.`
    : `🔨 **${tag}** banned until ${formatDate(a.expiresAt)} — base-zone enforcement.`;
}
