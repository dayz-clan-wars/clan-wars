import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { BOUNTY_DEFAULT_MS, BOUNTY_MAX_MS, BOUNTY_REASON_MAX } from "@factions/domain";
import { openBountiesDb, placeBountyDb, revokeBountyDb, searchBountyTargetsDb, type OpenBounty } from "@factions/roster/internal";
import type { AutocompleteSource, CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const HOUR = 3_600_000;
const reply = (content: string): Reply => ({ content, ephemeral: true });
const ADMIN_ONLY = reply("Only an admin can place or lift bounties.");
const hours = (ms: number) => Math.floor(ms / HOUR);

/** Discord's own hard cap on a message/reply body. */
const REPLY_MAX = 2_000;
/** A reason can be up to `BOUNTY_REASON_MAX` (200) chars; a listing row keeps it short so 25 rows can't overflow. */
const REASON_PREVIEW_MAX = 60;

function truncateReason(reason: string): string {
  return reason.length > REASON_PREVIEW_MAX ? `${reason.slice(0, REASON_PREVIEW_MAX - 1)}…` : reason;
}

function summarize(b: OpenBounty): string {
  return `#${b.id} ${b.gamertag}: ${hours(b.servedMs)} of ${hours(b.budgetMs)} h served. ${truncateReason(b.reason)}`;
}

/** Joins rows under Discord's 2,000-char reply limit, dropping trailing rows behind an "…and N more" line rather than overflowing. */
function joinUnderLimit(rows: string[]): string {
  const joined = rows.join("\n");
  if (joined.length <= REPLY_MAX) return joined;
  const kept: string[] = [];
  let len = 0;
  for (const [i, row] of rows.entries()) {
    const addition = (kept.length > 0 ? 1 : 0) + row.length;
    // Reserve room for the "…and N more" footer that will follow this row, for however many rows are left after it.
    const remainingAfter = rows.length - (i + 1);
    const footer = remainingAfter > 0 ? `\n…and ${remainingAfter} more`.length : 0;
    if (len + addition + footer > REPLY_MAX) break;
    kept.push(row);
    len += addition;
  }
  const remaining = rows.length - kept.length;
  return remaining > 0 ? `${kept.join("\n")}\n…and ${remaining} more` : kept.join("\n");
}

/**
 * ⚠️ `isAdmin` is checked here as well as by `setDefaultMemberPermissions`, for
 * `/award`'s reason: a channel permission overwrite can put the command back in
 * front of a member.
 */
async function place(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  if (!ctx.bountiesEnabled) return reply("Bounties are off. Set `BOUNTY_TICK` to turn them on.");
  const target = input.string("player");
  if (!target) return reply("Pick the player from the list.");
  const out = await placeBountyDb(ctx.db, {
    target, reason: input.string("reason") ?? "", hours: input.integer("hours"),
    adminDiscordId: input.actorDiscordId, now: ctx.now,
  });
  if (!out.ok) {
    return reply({
      "unknown-player": "The server has never seen that player. Pick one from the list.",
      "ambiguous-player": "More than one character has carried that name. Pick the right one from the list.",
      "already-open": "That player already has an open bounty. Lift it first to change it.",
      "bad-hours": `Hours must be between 1 and ${hours(BOUNTY_MAX_MS)}.`,
      "no-reason": "Say why. It is posted publicly and sent to them.",
      "reason-too-long": `Keep the reason under ${BOUNTY_REASON_MAX} characters.`,
    }[out.reason]);
  }
  console.log(`bounty: ${input.actorDiscordId} placed #${out.bountyId} on ${target}`);
  return reply(`Bounty #${out.bountyId} on **${out.gamertag}** for ${hours(out.budgetMs)} h online. It will be announced in the server events channel within a tick.`);
}

async function revoke(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const id = Number(input.string("bounty"));
  if (!Number.isInteger(id) || id <= 0) return reply("Pick a bounty from the list.");
  const out = await revokeBountyDb(ctx.db, { bountyId: id, adminDiscordId: input.actorDiscordId, now: ctx.now });
  if (!out.ok) return reply(out.reason === "not-found" ? `There is no bounty #${id}.` : `Bounty #${id} has already ended.`);
  console.log(`bounty: ${input.actorDiscordId} revoked #${id}`);
  const channelNotice = ctx.bountiesEnabled
    ? "The channel is told, and so are they if they are linked."
    : "The channel posts when BOUNTY_TICK is back on, and so does the DM to them if they are linked.";
  return reply(`Bounty #${id} lifted. ${channelNotice}`);
}

async function list(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const rows = await openBountiesDb(ctx.db, ctx.now);
  return reply(rows.length === 0 ? "There are no open bounties." : joinUnderLimit(rows.map(summarize)));
}

/**
 * Every character the log has seen, by prefix, linked or not (spec §2.2).
 *
 * ⚠️ Not `ctx.roster.searchGamertags`: that is `/link`'s search and returns only
 * UNLINKED characters, which hid every linked player from this command in production.
 */
const characters: AutocompleteSource = async (ctx, a) =>
  (await searchBountyTargetsDb(ctx.db, a.value)).map((m) => ({ name: m.gamertag, value: m.dayzId }));

const openOnes: AutocompleteSource = async (ctx, a) => {
  const q = a.value.toLowerCase();
  return (await openBountiesDb(ctx.db, ctx.now))
    .filter((b) => !q || summarize(b).toLowerCase().includes(q))
    .map((b) => ({ name: summarize(b).slice(0, 100), value: String(b.id) }));
};

export const bountyGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("Put a bounty on a player, as a punishment")
    // ⚠️ Discord's own gate, so members never see it. The handlers check again.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("place").setDescription("Put a bounty on a player")
      .addStringOption((o) => o.setName("player").setDescription("Their in-game name").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("reason").setDescription("Why; posted publicly and sent to them").setRequired(true).setMaxLength(BOUNTY_REASON_MAX))
      .addIntegerOption((o) => o.setName("hours").setDescription(`Online hours to serve (default ${hours(BOUNTY_DEFAULT_MS)})`).setMinValue(1).setMaxValue(hours(BOUNTY_MAX_MS))))
    .addSubcommand((c) => c
      .setName("revoke").setDescription("Lift a bounty")
      .addStringOption((o) => o.setName("bounty").setDescription("Which bounty").setRequired(true).setAutocomplete(true)))
    .addSubcommand((c) => c.setName("list").setDescription("Show open bounties")),
  specs: [
    { path: "bounty place", handler: place, autocomplete: { player: characters } },
    { path: "bounty revoke", handler: revoke, autocomplete: { bounty: openOnes } },
    { path: "bounty list", handler: list },
  ],
};
