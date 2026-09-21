import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { airdropEvents, servers } from "@factions/db";
import { AIRDROP_COLOURS, AIRDROP_LOCATIONS, chooseAirdrop, nextRestartAt } from "@factions/domain";
import { and, eq, inArray } from "drizzle-orm";
import { airdropText } from "../airdrop-text.js";
import type { CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });
const place = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);

/**
 * Place a drop by hand, for the next restart (§3 does not get a vote on it).
 *
 * ⚠️ `manual: true` is the whole point: the weekly cap is a budget for the
 * AUTOMATIC trigger, and an admin placing one for an event, a stream or a test
 * must not spend it. The 24h gap and the one-at-a-time guard still apply — see
 * the column's comment in the schema for why those two are different.
 *
 * ⚠️ Row first, post second, and the row is FAILED if the post throws. Spec §9:
 * only the location is announced and there is no in-world marker, so a drop
 * nobody was told about is a drop nobody ever finds.
 */
async function placeAirdrop(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can place an airdrop.");
  if (!ctx.serverEvents) {
    return reply("AIRDROP_TICK is off, so nothing would ever place this drop. Turn it on first.");
  }

  const location = (input.string("location") ?? "").toLowerCase();
  if (!AIRDROP_LOCATIONS.includes(location as never)) {
    return reply(`${location || "That"} is not one of the ${AIRDROP_LOCATIONS.length} staged locations.`);
  }
  const asked = input.string("colour")?.toLowerCase() ?? null;
  if (asked && !AIRDROP_COLOURS.includes(asked as never)) {
    return reply(`${asked} is not one of the three colours.`);
  }
  const colour = (asked ?? chooseAirdrop([], Math.random).colour) as "blue" | "orange" | "yellow";

  // ⚠️ Per server, like the tick: a drop is a file on one mission. One active
  // server today; a second one makes this command need a `server:` option, and
  // `airdropTick` already loops rather than assuming.
  const [server] = await ctx.db.select({ id: servers.id }).from(servers)
    .where(eq(servers.active, true)).limit(1);
  if (!server) return reply("No active server to place a drop on.");

  const open = await ctx.db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, server.id),
    inArray(airdropEvents.state, ["announced", "live"]),
  ));
  if (open.length > 0) {
    return reply("A drop is already announced or live. Only one at a time.");
  }

  const slot = nextRestartAt(ctx.now);
  await ctx.db.insert(airdropEvents).values({
    serverId: server.id, slotAt: slot, location, colour, decidedAt: ctx.now,
    // ⚠️ pop and threshold are recorded as 0, not as the live numbers: this row
    // is not evidence of a peak, and storing the current pop would make the
    // history read as if the trigger had fired when it had not.
    popAtDecision: 0, threshold: "0", state: "announced", manual: true,
    detail: { by: input.actorDiscordId },
  });

  try {
    await ctx.serverEvents(airdropText(location, slot));
  } catch (err) {
    await ctx.db.update(airdropEvents).set({ state: "failed", endedAt: ctx.now, detail: { reason: "never announced" } })
      .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
    console.error("airdrop: manual announcement failed to post — nothing placed", err);
    return reply("I could not post the announcement, so I have not placed the drop. Check SERVER_EVENTS_CHANNEL_ID.");
  }

  await ctx.db.update(airdropEvents).set({ announcedAt: ctx.now })
    .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
  console.log(`airdrop: ${input.actorDiscordId} placed ${location}/${colour} by hand for ${slot.toISOString()}`);

  return reply([
    `Announced: **${place(location)}**, ${colour}.`,
    `It goes in at the ${slot.toISOString()} restart and comes out at the one after.`,
    "This one does not count against the weekly cap.",
  ].join("\n"));
}

export const airdropGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("airdrop")
    .setDescription("Place an airdrop by hand")
    // ⚠️ Discord's own gate, so the command is hidden from members rather than
    // merely refused. The handler checks again; see its comment.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("place")
      .setDescription("Place a drop at the next restart, without spending the weekly cap")
      .addStringOption((o) => o
        .setName("location").setDescription("Where it lands").setRequired(true)
        .addChoices(...AIRDROP_LOCATIONS.map((l) => ({ name: place(l), value: l }))))
      .addStringOption((o) => o
        .setName("colour").setDescription("Which container (left off, it is rolled)").setRequired(false)
        .addChoices(...AIRDROP_COLOURS.map((c2) => ({ name: c2, value: c2 }))))),
  specs: [{ path: "airdrop place", handler: placeAirdrop }],
};
