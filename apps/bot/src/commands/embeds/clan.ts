import { EmbedBuilder } from "discord.js";
import type { ClanView } from "@factions/roster";
import { atRel, when } from "@factions/copy";
import { playerLink } from "../../site-links.js";

const GOLD = 0xc8a34a;

/**
 * `/clan info` — the site's /clan page.
 *
 * ⚠️ `clan.base` is the viewer's own clan's pole and is the ONLY coordinate
 * this card may carry. `rebindCandidates` is deliberately rendered by raiser
 * and time: a pole key is a coordinate in disguise. This card IS read by
 * every rank including a pending member, but the base field itself is gated
 * to full members only — see the check below.
 */
export function clanEmbed(view: ClanView, siteBaseUrl: string): EmbedBuilder {
  const player = (gamertag: string | null, fallback: string) => gamertag ? playerLink(siteBaseUrl, gamertag) : fallback;
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${view.clan.name} [${view.clan.tag}]`)
    .setURL(`${siteBaseUrl}/clan`)
    .setDescription(`You are **${view.me.role}**${view.me.status === "full" ? "" : ` (${view.me.status})`}.`);

  // ⚠️ Gated here, not in `clanForDb`: that read is shared with the website,
  // which never renders the coordinate at all (see `mapState` in
  // packages/roster/src/map.ts, which excludes pending members from the map
  // entirely). `clanForDb` computes `base` for every rank, so this card is
  // the only place that decides who actually sees it — a pending member has
  // done nothing but have a join request accepted, and handing them the
  // clan's exact base is the cheapest path a raider has to a base fix.
  if (view.clan.base && view.me.status === "full") {
    embed.addFields({ name: "Base", value: `${Math.round(view.clan.base.x)}, ${Math.round(view.clan.base.z)}`, inline: true });
  }
  embed.addFields({ name: "Status", value: view.clan.status, inline: true });
  embed.addFields({ name: "Recruiting", value: view.clan.recruiting ? "Yes" : "No", inline: true });

  if (view.roster.length > 0) {
    embed.addFields({
      name: `Roster (${view.roster.length})`,
      value: view.roster.map((r) => `• ${player(r.gamertag, r.discordId)} — ${r.role}${r.status === "full" ? "" : ` (${r.status})`}`)
        .join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (view.requestsIn.length > 0) {
    embed.addFields({ name: `Requests in (${view.requestsIn.length})`, value: "`/roster decide`", inline: true });
  }
  if (view.invitesOut.length > 0) {
    embed.addFields({ name: `Invites out (${view.invitesOut.length})`, value: "`/roster revoke`", inline: true });
  }
  if (view.rebindCandidates.length > 0) {
    embed.addFields({
      name: "Poles your flag was raised at",
      value: view.rebindCandidates.map((c) => `• by ${c.by}, ${atRel(c.raisedAt) ?? when(c.raisedAt)} — \`/clan rebind\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  const lead = view.leadership;
  if (lead.openClaim) {
    embed.addFields({ name: "Succession claim open", value: `${playerLink(siteBaseUrl, lead.openClaim.claimantGamertag)} claimed the seat.`, inline: false });
  }
  if (lead.openVote) {
    embed.addFields({
      name: "No-confidence vote open",
      value: `${lead.openVote.ballots} of ${lead.openVote.threshold} needed, nominating ${playerLink(siteBaseUrl, lead.openVote.nomineeGamertag)}.`
        + (lead.openVote.inElectorate && !lead.openVote.myBallot ? " — `/lead ballot`" : ""),
      inline: false,
    });
  }
  return embed;
}
