import { BAN_REASON_TEXT, type BanAnnouncementKind, type BanReason } from "@factions/domain";
import { at } from "@factions/copy";
import { escapeMarkdown } from "./kill-feed-embed.js";

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
  if (a.expiresAt === null) return `🔨 **${tag}** banned permanently — ${BAN_REASON_TEXT[a.reason]}.`;
  // ⚠️ `at()` degrades to null on an unrepresentable instant (copy's
  // contract) — same null-degrade pattern as `war-log-text.ts`'s
  // `season_closed`, chosen over a hand-formatted fallback: that fallback
  // (`formatDate`, removed here) rendered "NaN undefined NaN" on an
  // unparseable `expiresAt`, the opposite of the "keeps the line truthful"
  // this comment used to claim. Dropping the clause instead of a garbled
  // date is what actually stays truthful.
  const when = at(new Date(a.expiresAt));
  return when
    ? `🔨 **${tag}** banned until ${when} — ${BAN_REASON_TEXT[a.reason]}.`
    : `🔨 **${tag}** banned — ${BAN_REASON_TEXT[a.reason]}.`;
}
