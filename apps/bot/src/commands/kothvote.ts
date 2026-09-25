import { SlashCommandBuilder } from "discord.js";
import { kothVotes, kothVoteVoters, servers } from "@factions/db";
import {
  KOTH_MIN_GAP_MS, KOTH_VOTE_MIN_POP, KOTH_VOTE_TURNOUT_MIN, chooseKothTown, kothGapOk, kothLocation, turnoutFloor,
  voteClosesAt, voteTargetSlot,
} from "@factions/domain";
import { and, eq } from "drizzle-orm";
import { hhmm, voteMessage, type VoteView } from "../koth-text.js";
import { kothOpen, lastKothSlot, linkedOnline, recentTowns, slotTakenBy } from "../koth-vote-store.js";
import { onlineNow } from "../population.js";
import type { CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });
const UNIQUE_VIOLATION = "23505";

/** ⚠️ The pre-checks are plain SELECTs; a racing /kothvote reaches the INSERT. */
export function voteConstraintReply(constraint: string): string | null {
  if (constraint === "koth_votes_one_open") return "A King of the Hill vote is already open.";
  if (constraint === "koth_votes_slot_uq") return "There has already been a vote for that restart.";
  return null;
}

export const voteView = (v: typeof kothVotes.$inferSelect, starter: string): VoteView =>
  ({ town: kothLocation(v.location)?.name ?? v.location, slotAt: v.slotAt, closesAt: v.closesAt, floor: v.turnoutFloor, starter });

async function start(ctx: Ctx, input: CommandInput): Promise<Reply> {
  const kothVote = ctx.kothVote;
  if (!kothVote?.enabled) return reply("King of the Hill voting is switched off.");
  const [server] = await ctx.db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
  if (!server) return reply("No active server.");
  const electorate = await linkedOnline(ctx.db, server.id);
  const me = electorate.find((e) => e.discordId === input.actorDiscordId);
  if (!me) return reply("You need to be linked and in game to start a vote.");
  if (await onlineNow(ctx.db, server.id, ctx.now) < KOTH_VOTE_MIN_POP) {
    return reply(`A vote needs at least ${KOTH_VOTE_MIN_POP} players on the server.`);
  }
  const [open] = await ctx.db.select({ id: kothVotes.id }).from(kothVotes)
    .where(and(eq(kothVotes.serverId, server.id), eq(kothVotes.state, "open"))).limit(1);
  if (open) return reply(voteConstraintReply("koth_votes_one_open")!);
  const slot = voteTargetSlot(ctx.now);
  const [held] = await ctx.db.select({ id: kothVotes.id }).from(kothVotes)
    .where(and(eq(kothVotes.serverId, server.id), eq(kothVotes.slotAt, slot))).limit(1);
  if (held) return reply(voteConstraintReply("koth_votes_slot_uq")!);
  const taken = await slotTakenBy(ctx.db, server.id, slot);
  if (taken === "airdrop") return reply(`An airdrop is set for the ${hhmm(slot)} restart.`);
  if (taken === "koth" || await kothOpen(ctx.db, server.id)) return reply("A King of the Hill event is already scheduled or live.");
  if (!kothGapOk(slot, await lastKothSlot(ctx.db, server.id, slot))) {
    return reply(`The ${hhmm(slot)} restart is within ${KOTH_MIN_GAP_MS / 3_600_000} hours of the last King of the Hill.`);
  }
  // ⚠️ Refused up front: with fewer than the minimum electorate the floor can never
  // be met, and a vote that cannot pass is only a public notice that it failed.
  if (electorate.length < KOTH_VOTE_TURNOUT_MIN) {
    return reply(`Not enough linked players online: a vote needs at least ${KOTH_VOTE_TURNOUT_MIN}.`);
  }

  const town = chooseKothTown(await recentTowns(ctx.db, server.id), Math.random);
  let vote: typeof kothVotes.$inferSelect;
  try {
    vote = await ctx.db.transaction(async (tx) => {
      const [v] = await tx.insert(kothVotes).values({
        serverId: server.id, slotAt: slot, location: town.slug, startedByDiscordId: input.actorDiscordId,
        openedAt: ctx.now, closesAt: voteClosesAt(slot), electorateSize: electorate.length,
        turnoutFloor: turnoutFloor(electorate.length), state: "open",
      }).returning();
      await tx.insert(kothVoteVoters).values(electorate.map((e) => ({
        voteId: v!.id, discordId: e.discordId, dayzId: e.dayzId,
        ...(e.discordId === input.actorDiscordId ? { ballot: true, castAt: ctx.now } : {}),
      })));
      return v!;
    });
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown };
    const mapped = e?.code === UNIQUE_VIOLATION && typeof e.constraint_name === "string" ? voteConstraintReply(e.constraint_name) : null;
    if (mapped) return reply(mapped);
    throw err;
  }

  const content = voteMessage(voteView(vote, me.gamertag), { yes: 1, no: 0 });
  try {
    const { channelId, messageId } = await kothVote.channel.post(content, vote.id);
    await ctx.db.update(kothVotes).set({ channelId, messageId, tallyText: content }).where(eq(kothVotes.id, vote.id));
  } catch (err) {
    // ⚠️ A vote nobody can see is not a vote, and an `open` one would block every
    // other vote and the automatic trigger for this slot. `result_posted_at` is
    // set so the tick does not announce a result for it.
    await ctx.db.update(kothVotes).set({ state: "void", closedAt: ctx.now, resultPostedAt: ctx.now, detail: { reason: "never posted" } })
      .where(eq(kothVotes.id, vote.id));
    console.error("kothvote: the vote message failed to post — vote voided", err);
    return reply("I could not post the vote, so there is no vote. Tell an admin.");
  }
  return reply(`Vote opened for the ${hhmm(slot)} restart at ${town.name}. Your Yes is counted.`);
}

/**
 * A Yes/No press (spec §6.3). ⚠️ Eligibility is the voter row, never the button:
 * anyone in the channel can press it.
 */
export async function castBallot(ctx: Ctx, a: { actorDiscordId: string; voteId: number; yes: boolean }): Promise<Reply> {
  const [row] = await ctx.db.select({ state: kothVotes.state, closesAt: kothVotes.closesAt })
    .from(kothVoteVoters).innerJoin(kothVotes, eq(kothVotes.id, kothVoteVoters.voteId))
    .where(and(eq(kothVoteVoters.voteId, a.voteId), eq(kothVoteVoters.discordId, a.actorDiscordId))).limit(1);
  if (!row) return reply("Only linked players who were in game when this vote opened can vote on it.");
  // ⚠️ `closes_at`, not just `state`: the tick may not have closed it yet.
  if (row.state !== "open" || ctx.now >= row.closesAt) return reply("This vote has closed.");
  await ctx.db.update(kothVoteVoters).set({ ballot: a.yes, castAt: ctx.now })
    .where(and(eq(kothVoteVoters.voteId, a.voteId), eq(kothVoteVoters.discordId, a.actorDiscordId)));
  return reply(`Counted: ${a.yes ? "Yes" : "No"}. You can change it until the vote closes.`);
}

export const kothVoteGroup: CommandGroup = {
  // ⚠️ Its own command, not a /koth subcommand: Discord sets permissions per
  // command, and /koth keeps ManageGuild so players never see schedule/cancel.
  command: new SlashCommandBuilder().setName("kothvote").setDescription("Call a vote for King of the Hill at an upcoming restart"),
  specs: [{ path: "kothvote", handler: start }],
};
