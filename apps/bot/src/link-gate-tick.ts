import type { Database } from "@factions/db";
import { bans, identityLinks, players, playerSessions, verificationChallenges } from "@factions/db";
import {
  BAN_ACTIVE_STATUSES, type BanActiveStatus, LINK_TO_PLAY_FROM, LINK_TO_PLAY_LIFT_WINDOW_MS, linkGateAction, unlinkedPlayMs, type Interval, type LinkGateFacts,
} from "@factions/domain";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { escapeMarkdown } from "./site-links.js";

export type Who = { dayzId: string; gamertag: string };
export type LinkGateResult = { banned: Who[]; lifted: Who[]; closed: Who[] };

/** When several are active, the one the rule should see first (the brief's order). */
const PREFER: BanActiveStatus[] = ["applied", "lift_pending", "pending"];

/**
 * Link to play (spec 2026-11-06 §3): bans a gamertag that plays unlinked past
 * its grace hour or loses its link, lifts the ban once a day when someone
 * starts linking it, and closes it for good once it links.
 *
 * ⚠️ This tick NEVER calls Nitrado. It writes `unlinked` rows and lift
 * requests; `banTick` is the only thing that talks to the ban list, and its
 * reference counting (`stillBanned`) is what stops a lift freeing a gamertag
 * that also has a zone, conduct or (old) Hub ban.
 *
 * ⚠️ Only `reason = 'unlinked'` rows are read as this gate's history or
 * written. Every other reason is invisible here, by query.
 *
 * ⚠️ Level-triggered: each pass recomputes what should be true from the
 * facts (`linkGateAction`), so a lost write is repaired on the next pass.
 *
 * `from` defaults to LINK_TO_PLAY_FROM and exists for tests only: the launch
 * instant is a constant, and tests need a clock start relative to their own
 * fixed `now`. `write: false` is the `LINK_TO_PLAY=dry` mode: the same
 * result, nothing written.
 */
export async function linkGateTick(
  db: Database,
  opts: { serverId: number; now: Date; write: boolean; from?: Date },
): Promise<LinkGateResult> {
  const { serverId, now, write } = opts;
  const from = opts.from ?? LINK_TO_PLAY_FROM;
  const out: LinkGateResult = { banned: [], lifted: [], closed: [] };
  const nowIso = now.toISOString();
  const fromIso = from.toISOString();

  // Candidates, bounded: anyone who played here since the clock start, lost a
  // link since then, or holds an active unlinked ban here — minus the linked,
  // unless they hold a ban this pass should close. Linked players are the bulk
  // of every server, so dropping them in SQL keeps the per-id reads small.
  const rows = await db.execute<{ dayz_id: string }>(sql`
    select c.dayz_id from (
      select dayz_id from player_sessions
        where server_id = ${serverId}
          and connected_at < ${nowIso}::timestamptz
          and (disconnected_at is null or disconnected_at > ${fromIso}::timestamptz)
      union
      select dayz_id from identity_link_ends
        where ended_at >= ${fromIso}::timestamptz and ended_at <= ${nowIso}::timestamptz
      union
      select dayz_id from bans
        where server_id = ${serverId} and reason = 'unlinked'
          and status in (${sql.join(BAN_ACTIVE_STATUSES.map((st) => sql`${st}`), sql`, `)})
    ) c
    where not exists (select 1 from identity_links l where l.dayz_id = c.dayz_id)
       or exists (
         select 1 from bans b
         where b.server_id = ${serverId} and b.dayz_id = c.dayz_id
           and b.reason = 'unlinked' and b.status in ('pending', 'applied')
       )
  `);
  const ids = [...rows].map((r) => r.dayz_id);
  if (ids.length === 0) return out;

  const linked = new Set((await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
    .where(inArray(identityLinks.dayzId, ids))).map((r) => r.dayzId));

  const sessions = new Map<string, Interval[]>();
  for (const s of await db.select({ dayzId: playerSessions.dayzId, from: playerSessions.connectedAt, to: playerSessions.disconnectedAt })
    .from(playerSessions).where(and(
      eq(playerSessions.serverId, serverId),
      inArray(playerSessions.dayzId, ids),
      sql`${playerSessions.connectedAt} < ${nowIso}::timestamptz`,
      sql`(${playerSessions.disconnectedAt} is null or ${playerSessions.disconnectedAt} > ${fromIso}::timestamptz)`,
    ))) {
    const list = sessions.get(s.dayzId) ?? [];
    list.push({ from: s.from, to: s.to });
    sessions.set(s.dayzId, list);
  }

  const ended = new Set([...(await db.execute<{ dayz_id: string }>(sql`
    select distinct dayz_id from identity_link_ends
    where ended_at >= ${fromIso}::timestamptz and ended_at <= ${nowIso}::timestamptz
      and dayz_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `))].map((r) => r.dayz_id));

  // ⚠️ Matched on `target_dayz_id` alone, as the PC gate did: anyone may open
  // an attempt against any public gamertag. The once-a-day lift (spec §4) is
  // what keeps that from being free play time.
  const open = new Set((await db.select({ dayzId: verificationChallenges.targetDayzId }).from(verificationChallenges).where(and(
    inArray(verificationChallenges.targetDayzId, ids),
    isNull(verificationChallenges.completedAt),
    isNull(verificationChallenges.canceledAt),
    gt(verificationChallenges.expiresAt, now),
  ))).map((r) => r.dayzId));

  const history = new Map<string, (typeof bans.$inferSelect)[]>();
  for (const b of await db.select().from(bans).where(and(
    eq(bans.serverId, serverId), eq(bans.reason, "unlinked"), inArray(bans.dayzId, ids),
  ))) {
    const list = history.get(b.dayzId) ?? [];
    list.push(b);
    history.set(b.dayzId, list);
  }

  const gamertags = new Map((await db.select({ dayzId: players.dayzId, gamertag: players.gamertag }).from(players)
    .where(inArray(players.dayzId, ids))).map((r) => [r.dayzId, r.gamertag]));

  const windowStart = now.getTime() - LINK_TO_PLAY_LIFT_WINDOW_MS;
  for (const dayzId of ids) {
    const mine = history.get(dayzId) ?? [];
    const active = PREFER.map((st) => mine.find((b) => b.status === st)).find((b) => b !== undefined);
    const liftTimes = mine.map((b) => b.liftedAt).filter((t): t is Date => t !== null);
    const lastLiftAt = liftTimes.length === 0 ? null : new Date(Math.max(...liftTimes.map((t) => t.getTime())));
    // ⚠️ A lift_pending row counts as this window's lift before banTick has
    // stamped its lifted_at, or a second attempt in that gap lifts again.
    const liftsInWindow = mine.filter((b) =>
      b.status === "lift_pending" || (b.liftedAt !== null && b.liftedAt.getTime() > windowStart)).length;

    const facts: LinkGateFacts = {
      linked: linked.has(dayzId),
      playedMs: unlinkedPlayMs(sessions.get(dayzId) ?? [], from, now),
      linkEndedSinceFrom: ended.has(dayzId),
      bannedSinceFrom: mine.some((b) => b.bannedAt.getTime() >= from.getTime()),
      activeBan: (active?.status as BanActiveStatus | undefined) ?? null,
      lastLiftAt,
      liftsInWindow,
      attemptOpen: open.has(dayzId),
      now,
    };
    const action = linkGateAction(facts);
    if (action === "none") continue;

    // A player who lost a link may have no `players` row only if they never
    // connected to an ingested server; the dayz id is still a valid ban key.
    const who: Who = { dayzId, gamertag: active?.gamertag ?? gamertags.get(dayzId) ?? dayzId };

    if (action === "ban") {
      if (write) {
        await db.insert(bans).values({
          serverId, dayzId, gamertag: who.gamertag, bannedAt: now,
          // ⚠️ No expiry: it ends by linking (close) or by the daily lift.
          expiresAt: null, status: "pending", reason: "unlinked",
        });
      }
      out.banned.push(who);
      continue;
    }

    // lift or close: both hand the row to banTick's lift arm.
    if (!active) continue;
    // ⚠️ A `pending` row that banTick has already TRIED to apply may be on the
    // list: a write can land with its response lost. Closing it here would
    // stamp [] and leave its dry_run default, so the lift arm would remove
    // nothing and the entry would stay forever. Leave it to banTick: it either
    // applies (stamping what it wrote, and the next pass closes the applied
    // row) or fails out (and its cleanup removes what was attempted).
    if (active.status === "pending" && active.attempts > 0) continue;
    if (write) {
      // ⚠️ A `pending` row with no attempts never reached Nitrado.
      // `nitrado_added = []` makes the lift arm remove nothing; null would fall
      // back to removing both identifiers and could free an entry the owner
      // added by hand.
      const set = active.status === "pending"
        ? { status: "lift_pending" as const, nitradoAdded: [] as string[] }
        : { status: "lift_pending" as const };
      // Guarded on the status this pass read, so a banTick that moved the row
      // meanwhile is not overwritten; the next pass sees the new state.
      const [hit] = await db.update(bans).set(set)
        .where(and(eq(bans.id, active.id), eq(bans.status, active.status)))
        .returning({ id: bans.id });
      if (!hit) continue;
    }
    (action === "lift" ? out.lifted : out.closed).push(who);
  }

  return out;
}

/**
 * The ops-channel lines for one pass, one per gamertag. `dry` reads "Would …"
 * because nothing was written.
 *
 * ⚠️ The ops poster parses mentions and a gamertag is player text: markdown is
 * escaped and every `@` broken with a zero-width space, so "@everyone" stays text.
 */
export function linkGateOpsLines(r: LinkGateResult, dry: boolean): { dayzId: string; content: string }[] {
  const name = (w: Who) => escapeMarkdown(w.gamertag).replaceAll("@", "@\u200b");
  const line = (w: Who, head: string, tail: string) => ({ dayzId: w.dayzId, content: `${head}: **${name(w)}** (\`${w.dayzId}\`) ${tail}` });
  return [
    ...r.banned.map((w) => line(w, dry ? "🚫 Would ban" : "🚫 Unlinked ban queued", "is playing without a linked account.")),
    ...r.lifted.map((w) => line(w, dry ? "🔓 Would lift" : "🔓 Unlinked ban lifting", "started linking — their one lift in 24 hours.")),
    ...r.closed.map((w) => line(w, dry ? "✅ Would close" : "✅ Unlinked ban closing", "has linked.")),
  ];
}
