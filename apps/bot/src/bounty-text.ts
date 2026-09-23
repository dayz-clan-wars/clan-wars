import { escapeMarkdown } from "discord.js";

export type BountyPost =
  | { kind: "placed"; target: string; reason: string; hours: number }
  | { kind: "claimed"; target: string; killer: string; weapon: string | null }
  | { kind: "expired"; target: string }
  | { kind: "revoked"; target: string };

const b = (s: string) => `**${escapeMarkdown(s)}**`;

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
        + `Their last known position is on the map until someone kills them or they have played ${p.hours} h online: ${siteBaseUrl}/map\n`
        + "Friendly fire and kills at the Hub don't count.";
    case "claimed":
      return `💀 ${b(p.killer)} collected the bounty on ${b(p.target)}${p.weapon ? ` with ${escapeMarkdown(p.weapon)}` : ""}.`;
    case "expired":
      return `⌛ The bounty on ${b(p.target)} has expired. They served their time.`;
    case "revoked":
      return `The bounty on ${b(p.target)} was lifted by an admin.`;
  }
}
