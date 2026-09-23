import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { BOUNTY_MAX_MS, BOUNTY_REASON_MAX } from "@factions/domain";
import { openBountiesDb, placeBountyDb, revokeBountyDb, type OpenBounty } from "@factions/roster/internal";
import type { AutocompleteSource, CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const HOUR = 3_600_000;
const reply = (content: string): Reply => ({ content, ephemeral: true });
const ADMIN_ONLY = reply("Only an admin can place or lift bounties.");
const hours = (ms: number) => Math.floor(ms / HOUR);

function summarize(b: OpenBounty): string {
  return `#${b.id} ${b.gamertag}: ${hours(b.servedMs)} of ${hours(b.budgetMs)} h served. ${b.reason}`;
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
    targetDayzId: target, reason: input.string("reason") ?? "", hours: input.integer("hours"),
    adminDiscordId: input.actorDiscordId, now: ctx.now,
  });
  if (!out.ok) {
    return reply({
      "unknown-player": "The server has never seen that player. Pick one from the list.",
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
  return reply(`Bounty #${id} lifted. The channel is told, and so are they if they are linked.`);
}

async function list(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const rows = await openBountiesDb(ctx.db, ctx.now);
  return reply(rows.length === 0 ? "There are no open bounties." : rows.map(summarize).join("\n"));
}

/** Same source as `/link`: the log's own list of characters, by prefix, linked or not (spec §2.2). */
const characters: AutocompleteSource = async (ctx, a) => {
  if (a.value.trim().length === 0) return [];
  const matches = await ctx.roster.searchGamertags(a.value.slice(0, 64));
  return matches.slice(0, 25).map((m) => ({ name: m.gamertag, value: m.dayzId }));
};

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
      .addIntegerOption((o) => o.setName("hours").setDescription("Online hours to serve (default 72)").setMinValue(1).setMaxValue(hours(BOUNTY_MAX_MS))))
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
