import { identityLinks, kothEvents, kothVotes, kothVoteVoters, servers, type Database } from "@factions/db";
import { kothGapOk, kothLocation, voteOutcome } from "@factions/domain";
import { and, eq, gte, isNotNull, isNull, ne } from "drizzle-orm";
import { voteView } from "./commands/kothvote.js";
import { voteFailedText, voteMessage, votePassedText, voteVoidText, type Tally } from "./koth-text.js";
import type { KothVoteChannel } from "./koth-vote-channel.js";
import { kothOpen, lastKothSlot, slotTakenBy } from "./koth-vote-store.js";

type Vote = typeof kothVotes.$inferSelect;
/** Same bound and reasoning as airdrop-tick's SCRUB_SCAN_MS: never resurrect a long-dead row. */
const RESULT_SCAN_MS = 14 * 24 * 60 * 60 * 1000;

async function tally(db: Database, voteId: number): Promise<Tally> {
  const rows = await db.select({ ballot: kothVoteVoters.ballot }).from(kothVoteVoters).where(eq(kothVoteVoters.voteId, voteId));
  return { yes: rows.filter((r) => r.ballot === true).length, no: rows.filter((r) => r.ballot === false).length };
}
async function starterTag(db: Database, v: Vote): Promise<string> {
  const [l] = await db.select({ g: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.discordId, v.startedByDiscordId)).limit(1);
  return l?.g ?? "A player";
}
const town = (v: Vote) => kothLocation(v.location)?.name ?? v.location;

/**
 * Keeps the open vote's tally current, closes it, and posts the result
 * (spec 2026-09-24 §6.4).
 *
 * ⚠️ Runs whether or not KOTH_VOTE is on (`enabled` only decides what a close
 * becomes): switching the feature off must finish a vote already running, and
 * never create an event from one.
 * ⚠️ Runs BEFORE kothDecideTick and airdropTick (tick-order.test.ts): a vote
 * closing at T−30 inserts its row before either looks at that slot.
 */
export async function kothVoteTick(
  db: Database, channel: KothVoteChannel, announce: (c: string) => Promise<void>, opts: { now: Date; enabled: boolean },
) {
  const out = { edited: 0, closed: 0, posted: 0 };
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      const [open] = await db.select().from(kothVotes).where(and(eq(kothVotes.serverId, s.id), eq(kothVotes.state, "open")));
      if (open && opts.now < open.closesAt) {
        const content = voteMessage(voteView(open, await starterTag(db, open)), await tally(db, open.id));
        if (content !== open.tallyText && open.channelId && open.messageId) {
          try {
            await channel.edit(open.channelId, open.messageId, content, open.id);
            await db.update(kothVotes).set({ tallyText: content }).where(eq(kothVotes.id, open.id));
            out.edited += 1;
          } catch (err) {
            console.warn(`kothvote: tally edit for vote ${open.id} failed`, err);
          }
        }
      } else if (open) {
        await close(db, open, opts);
        out.closed += 1;
      }
      out.posted += await postResults(db, s.id, channel, announce, opts.now);
    } catch (err) {
      console.error(`kothvote: server ${s.id} tick failed`, err);
    }
  }
  return out;
}

async function close(db: Database, open: Vote, opts: { now: Date; enabled: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    // ⚠️ Lock order: koth_votes → koth_vote_voters → koth_events.
    const [v] = await tx.select().from(kothVotes).where(and(eq(kothVotes.id, open.id), eq(kothVotes.state, "open"))).for("update");
    if (!v) return;
    const rows = await tx.select({ ballot: kothVoteVoters.ballot }).from(kothVoteVoters).where(eq(kothVoteVoters.voteId, v.id));
    const t = { yes: rows.filter((r) => r.ballot === true).length, no: rows.filter((r) => r.ballot === false).length };
    const done = (state: "passed" | "failed" | "void", detail: Record<string, string | number>, kothEventId?: number) =>
      tx.update(kothVotes).set({ state, closedAt: opts.now, kothEventId: kothEventId ?? null, detail: { ...detail, yes: t.yes, no: t.no } })
        .where(eq(kothVotes.id, v.id));
    // ⚠️ Never late (KotH spec §2.1): the session it was for has started.
    if (opts.now >= v.slotAt) { await done("void", { reason: "the vote expired before it could be counted" }); return; }
    if (!opts.enabled) { await done("void", { reason: "voting was switched off" }); return; }
    const r = voteOutcome({ cast: t.yes + t.no, yes: t.yes, floor: v.turnoutFloor });
    if (r.outcome === "failed") { await done("failed", { reason: r.reason }); return; }
    // ⚠️ Re-checked under the lock: an admin may have scheduled, or an airdrop been
    // placed, since the vote opened.
    const taken = await slotTakenBy(tx, v.serverId, v.slotAt);
    if (taken) { await done("void", { reason: `an ${taken === "koth" ? "event" : "airdrop"} took that restart` }); return; }
    if (await kothOpen(tx, v.serverId)) { await done("void", { reason: "another King of the Hill was scheduled first" }); return; }
    if (!kothGapOk(v.slotAt, await lastKothSlot(tx, v.serverId, v.slotAt))) { await done("void", { reason: "another King of the Hill ran too recently" }); return; }
    const loc = kothLocation(v.location)!;
    const [ev] = await tx.insert(kothEvents).values({
      serverId: v.serverId, slotAt: v.slotAt, location: v.location, centreX: String(loc.centreX), centreZ: String(loc.centreZ),
      state: "scheduled", origin: "vote", scheduledByDiscordId: v.startedByDiscordId, awardKey: null,
    }).returning({ id: kothEvents.id });
    await done("passed", { reason: "passed" }, ev!.id);
  });
}

/** Post, THEN stamp — a stamp first silences a post that never went out. */
async function postResults(db: Database, serverId: number, channel: KothVoteChannel, announce: (c: string) => Promise<void>, now: Date): Promise<number> {
  const closed = await db.select().from(kothVotes).where(and(
    eq(kothVotes.serverId, serverId), ne(kothVotes.state, "open"), isNull(kothVotes.resultPostedAt),
    isNotNull(kothVotes.closedAt), gte(kothVotes.closedAt, new Date(now.getTime() - RESULT_SCAN_MS)),
  ));
  let posted = 0;
  for (const v of closed) {
    const t: Tally = { yes: Number(v.detail.yes ?? 0), no: Number(v.detail.no ?? 0) };
    const reason = String(v.detail.reason ?? "");
    let text: string | null;
    let line: string;
    if (v.state === "passed") {
      // ⚠️ Past its slot, the event was never announced and koth-tick fails it with
      // no cancellation; announcing it now would name a session already under way.
      text = now < v.slotAt ? votePassedText(town(v), v.slotAt, t) : null;
      line = "Voting has closed: passed.";
    } else if (v.state === "failed") {
      text = voteFailedText(town(v), t, v.turnoutFloor, reason === "turnout" ? "turnout" : "majority");
      line = "Voting has closed: failed.";
    } else {
      text = voteVoidText(town(v), reason);
      line = `Voting has closed: ${reason}.`;
    }
    if (text) {
      try { await announce(text); } catch (err) { console.warn(`kothvote: result for vote ${v.id} failed to post — retrying next tick`, err); continue; }
    }
    await db.transaction(async (tx) => {
      await tx.update(kothVotes).set({ resultPostedAt: now }).where(eq(kothVotes.id, v.id));
      if (v.state === "passed" && text && v.kothEventId) {
        // ⚠️ `reminded_at` WITH `announced_at`: the vote closes at the reminder instant.
        await tx.update(kothEvents).set({ announcedAt: now, remindedAt: now }).where(eq(kothEvents.id, v.kothEventId));
      }
    });
    posted += 1;
    if (v.channelId && v.messageId) {
      const final = voteMessage(voteView(v, await starterTag(db, v)), t, line);
      await channel.edit(v.channelId, v.messageId, final, null)
        .catch((err: unknown) => console.warn(`kothvote: closing edit for vote ${v.id} failed`, err));
    }
  }
  return posted;
}
