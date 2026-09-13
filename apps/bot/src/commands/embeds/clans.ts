import { EmbedBuilder } from "discord.js";
import type { ClanPage, DirectoryEntry } from "@factions/roster";

const GOLD = 0xc8a34a;

/**
 * `/clans list`. Recruiting first — `directory()` already returns them in
 * that order, so this does not re-sort and cannot disagree with the site.
 *
 * ⚠️ Public data only. `DirectoryEntry` has no base and must never be joined
 * to one here: this card is readable by anyone, including a raider.
 */
const FOOTER_TEXT = "`/clans show tag:` for one clan, `/clans join tag:` to ask to join.";
const TITLE = "Clans";
// Discord's own embed caps: 25 fields, and 6000 characters total across
// title, description, every field's name+value, and the footer. Unreachable
// at today's scale, but at roughly 120 clans (each line is short, but 25
// fields × 1024 chars is only ~500 clans, and 6000 total chars is tighter
// still) `/clans list` would build an embed Discord rejects outright, which
// reaches the player as `HANDLER_FAILED` — a directory listing failing
// because it grew, with no site outage and no bug in sight.
const MAX_FIELDS = 25;
const MAX_TOTAL = 6000;

export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/clans`);
  if (entries.length === 0) return embed.setDescription("No clans yet.");

  const line = (e: DirectoryEntry) =>
    `• **${e.name}** [${e.tag}] — ${e.memberCount} member${e.memberCount === 1 ? "" : "s"}`
    + (e.alpha ? " · Alpha" : "") + (e.recruiting ? " · Recruiting" : "");

  // One field per 1024-character chunk: Discord rejects a longer field
  // value. `count` remembers how many entries landed in each field, so if
  // fields later get dropped for the caps above, the "+N more" notice can
  // still say exactly how many clans were left off.
  const fields: { name: string; value: string; count: number }[] = [];
  let chunk: string[] = [];
  let n = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    fields.push({ name: n === 0 ? `${entries.length} clans` : "…", value: chunk.join("\n"), count: chunk.length });
    chunk = []; n += 1;
  };
  for (const e of entries) {
    const next = line(e);
    if ([...chunk, next].join("\n").length > 1024) flush();
    chunk.push(next);
  }
  flush();

  const totalCost = fields.reduce((s, f) => s + f.name.length + f.value.length, 0) + TITLE.length + FOOTER_TEXT.length;
  if (fields.length <= MAX_FIELDS && totalCost <= MAX_TOTAL) {
    for (const f of fields) embed.addFields({ name: f.name, value: f.value, inline: false });
    embed.setFooter({ text: FOOTER_TEXT });
    return embed;
  }

  // Over a cap: keep as many fields as fit, reserving one field slot for the
  // "+N more" notice, and say plainly how many clans were left off rather
  // than truncating silently.
  let used = TITLE.length + FOOTER_TEXT.length;
  let kept = 0;
  let shown = 0;
  for (const f of fields) {
    if (kept >= MAX_FIELDS - 1) break;
    const cost = f.name.length + f.value.length;
    if (used + cost > MAX_TOTAL) break;
    embed.addFields({ name: f.name, value: f.value, inline: false });
    used += cost;
    kept += 1;
    shown += f.count;
  }
  embed.addFields({ name: "…", value: `+${entries.length - shown} more — see the site.`, inline: false });
  embed.setFooter({ text: FOOTER_TEXT });
  return embed;
}

/** `/clans show` — one clan's public page. Same fields the site shows a stranger. */
export function clanPageEmbed(page: ClanPage, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${page.name} [${page.tag}]`)
    .setURL(`${siteBaseUrl}/clans/${page.tag}`)
    .addFields(
      { name: "Members", value: String(page.memberCount), inline: true },
      { name: "Recruiting", value: page.recruiting ? "Yes" : "No", inline: true },
      { name: "Raids / defenses", value: `${page.stats.raids} / ${page.stats.defenses}`, inline: true },
    );
  if (page.pitch) embed.setDescription(page.pitch.slice(0, 2048));
  if (page.playWindow) embed.addFields({ name: "Plays", value: page.playWindow, inline: true });
  if (page.language) embed.addFields({ name: "Language", value: page.language, inline: true });
  if (page.alphaWeeks > 0) embed.addFields({ name: "Alpha weeks", value: String(page.alphaWeeks), inline: true });
  if (page.roster.length > 0) {
    embed.addFields({
      name: "Roster",
      value: page.roster.map((r) => `• ${r.gamertag ?? "—"} — ${r.role}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (page.canRequest === "yes") embed.setFooter({ text: `Ask to join with /clans join tag: ${page.tag}` });
  return embed;
}
