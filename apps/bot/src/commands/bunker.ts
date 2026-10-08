import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { airdropEvents, kothEvents, servers } from "@factions/db";
import { BUNKER_KINDS, BUNKER_ROOMS, bunkerRoom, chooseAirdrop, nextRestartAt, type BunkerKind } from "@factions/domain";
import { and, eq, inArray } from "drizzle-orm";
import { airdropText } from "../airdrop-text.js";
import type { CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });

/**
 * Bring a bunker online by hand, for the next restart (§3 does not get a vote on it).
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
async function placeBunkerCommand(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can bring a bunker online.");
  if (!ctx.serverEvents) {
    return reply("AIRDROP_TICK is off, so nothing would ever bring this bunker online. Turn it on first.");
  }
  const room = bunkerRoom((input.string("room") ?? "").toLowerCase());
  if (!room) return reply(`${input.string("room") || "That"} is not one of the ${BUNKER_ROOMS.length} bunker rooms.`);
  const asked = input.string("kind")?.toLowerCase() ?? null;
  if (asked && !BUNKER_KINDS.includes(asked as BunkerKind)) return reply(`${asked} is not one of the two kinds.`);
  const kind = (asked ?? chooseAirdrop([], Math.random).kind) as BunkerKind;

  // ⚠️ Per server, like the tick: a drop is a file on one mission. One active
  // server today; a second one makes this command need a `server:` option, and
  // `airdropTick` already loops rather than assuming.
  const [server] = await ctx.db.select({ id: servers.id }).from(servers)
    .where(eq(servers.active, true)).limit(1);
  if (!server) return reply("No active server to bring a bunker online on.");

  const open = await ctx.db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, server.id),
    inArray(airdropEvents.state, ["announced", "live"]),
  ));
  if (open.length > 0) {
    return reply("A bunker is already announced or online. Only one at a time.");
  }

  const slot = nextRestartAt(ctx.now);
  // ⚠️ Spec §2.12: a King of the Hill session and an airdrop cannot share a slot.
  // The koth command refuses the symmetric case.
  const koth = await ctx.db.select({ id: kothEvents.id }).from(kothEvents).where(and(
    eq(kothEvents.serverId, server.id), eq(kothEvents.slotAt, slot), eq(kothEvents.state, "scheduled"),
  ));
  if (koth.length > 0) {
    return reply("King of the Hill holds that session. No bunker on top of it.");
  }
  await ctx.db.insert(airdropEvents).values({
    serverId: server.id, slotAt: slot, location: room.slug, kind, colour: null, decidedAt: ctx.now,
    // ⚠️ pop and threshold are recorded as 0, not as the live numbers: this row
    // is not evidence of a peak, and storing the current pop would make the
    // history read as if the trigger had fired when it had not.
    popAtDecision: 0, threshold: "0", state: "announced", manual: true,
    detail: { by: input.actorDiscordId },
  });

  try {
    await ctx.serverEvents(airdropText(room.name, slot));
  } catch (err) {
    await ctx.db.update(airdropEvents).set({ state: "failed", endedAt: ctx.now, detail: { reason: "never announced" } })
      .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
    console.error("airdrop: manual announcement failed to post — nothing placed", err);
    return reply("I could not post the announcement, so I have not brought the bunker online. Check SERVER_EVENTS_CHANNEL_ID.");
  }

  await ctx.db.update(airdropEvents).set({ announcedAt: ctx.now })
    .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
  console.log(`airdrop: ${input.actorDiscordId} placed bunker ${room.slug}/${kind} by hand for ${slot.toISOString()}`);

  return reply([
    `Announced: **${room.name}**, ${kind === "boom" ? "explosives" : "guns"}. Only you see the kind.`,
    `It comes online at the ${slot.toISOString()} restart and goes offline at the one after.`,
    "This one does not count against the weekly cap.",
  ].join("\n"));
}

export const bunkerGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("bunker")
    .setDescription("Bring a bunker online by hand")
    // ⚠️ Discord's own gate, so the command is hidden from members rather than
    // merely refused. The handler checks again; see its comment.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("place")
      .setDescription("Bring a bunker online at the next restart, without spending the weekly cap")
      .addStringOption((o) => o
        .setName("room").setDescription("Which keycard room").setRequired(true)
        .addChoices(...BUNKER_ROOMS.map((r) => ({ name: r.name, value: r.slug }))))
      .addStringOption((o) => o
        .setName("kind").setDescription("What is inside (left off, it is rolled)").setRequired(false)
        .addChoices({ name: "Explosives", value: "boom" }, { name: "Guns", value: "guns" }))),
  specs: [{ path: "bunker place", handler: placeBunkerCommand }],
};
