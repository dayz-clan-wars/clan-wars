import { escapeMarkdown } from "./kill-feed-embed.js";

/**
 * Where a claimed bounty's prize stands when the post goes out: granted, held
 * for an unlinked killer, or owed but not granted yet (a retry, or a prize ops
 * must grant by hand). Only `granted` may say they won it.
 */
export type PrizeState = "granted" | "unlinked" | "pending";

/** A bounty's prize, as the posts name it. `days` is fixed at placement. */
export type BountyPrize = { label: string; days: number };

export type BountyPost =
  | { kind: "placed"; target: string; reason: string; hours: number; prize: BountyPrize | null }
  | { kind: "claimed"; target: string; killer: string; weapon: string | null; prize: BountyPrize | null; prizeState: PrizeState }
  | { kind: "expired"; target: string }
  | { kind: "revoked"; target: string };

const b = (s: string) => `**${escapeMarkdown(s)}**`;
const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

/**
 * The #server-events copy for a bounty. Pure.
 *
 * ⚠️ No coordinate in any of these: the map is where the position lives, behind a
 * login and `no-store`. A number in the channel is a screenshot that outlives the bounty.
 * ⚠️ Names and the reason are player/admin text in a public channel — escaped here,
 * and posted with `allowedMentions: { parse: [] }` (discord.ts).
 */
export function bountyPostText(p: BountyPost, siteBaseUrl: string): string {
  switch (p.kind) {
    case "placed":
      return `🎯 **WANTED:** ${b(p.target)} — ${escapeMarkdown(p.reason)}.\n`
        + `Their position shows on the map while they're online, until someone kills them or they have played ${p.hours} h online: ${siteBaseUrl}/map\n`
        + (p.prize ? `🏆 Reward: ${b(p.prize.label)}, respawning every restart at a spot the winner picks for ${days(p.prize.days)}.\n` : "")
        + "Friendly fire and kills at the Hub don't count.";
    case "claimed": {
      const head = `💀 ${b(p.killer)} collected the bounty on ${b(p.target)}${p.weapon ? ` with ${escapeMarkdown(p.weapon)}` : ""}.`;
      if (!p.prize) return head;
      // ⚠️ An unlinked killer's prize is held, not lost: say so, and say how to get it,
      // or the one player it matters to reads the post as "you won nothing".
      switch (p.prizeState) {
        case "granted": return `${head} They win ${b(p.prize.label)}.`;
        case "unlinked": return `${head} Their ${b(p.prize.label)} is waiting for them. Link your character at ${siteBaseUrl}/link to claim it.`;
        case "pending": return `${head} Their ${b(p.prize.label)} is on its way.`;
      }
    }
    case "expired":
      return `⌛ The bounty on ${b(p.target)} has expired.`;
    case "revoked":
      return `The bounty on ${b(p.target)} was lifted by an admin.`;
  }
}
