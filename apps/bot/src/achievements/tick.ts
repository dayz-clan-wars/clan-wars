import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, HOLDING_STATUSES, type AchievementKey } from "@factions/domain";
import { achievementProgress, achievementUnlocks, factionMembers, factions, identityLinks, membershipHistory, players, servers, type Database } from "@factions/db";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { appendClanNoticeTx, noticeClanTx, noticeFullMembersTx, noticeUserTx } from "@factions/roster/internal";
import { RULES } from "./rules.js";
import { applyPinCounters, applyPositionCounters } from "./counters.js";
import {
  clearResume, collectEveryone, collectTouched, headWatermarks, ownerKey, pinsAfter, positionsAfter, readResume, readWatermarks,
  writeResume, writeWatermarks, type Watermarks,
} from "./touched.js";
import type { Owner, RuleResult } from "./types.js";

export type AchievementsTickOpts = {
  now?: Date;
  /** Owners evaluated per pass; the rest carry over. */
  batch?: number;
  /** Backfill: every owner, ignoring watermarks. */
  everyone?: boolean;
  /** false = backfill: unlock rows only, no notices. */
  announce?: boolean;
  achievementsChannelId?: string;
  onError?: (owner: Owner, key: AchievementKey, err: unknown) => void;
};
export type AchievementsTickResult = { evaluated: number; unlocked: number; carried: number; failed: number };

const KEYS_FOR = {
  player: ACHIEVEMENTS.filter((a) => a.owner === "player").map((a) => a.key),
  clan: ACHIEVEMENTS.filter((a) => a.owner === "clan").map((a) => a.key),
} as const;

/** Every rule of the owner's kind; a throw is reported per key and skips only that key. */
export async function evaluateOwner(db: Database, owner: Owner, now: Date, onError?: AchievementsTickOpts["onError"]): Promise<{ key: AchievementKey; result: RuleResult }[]> {
  const out: { key: AchievementKey; result: RuleResult }[] = [];
  for (const key of KEYS_FOR[owner.kind]) {
    // ⚠️ Per key, not per owner: one broken rule must never cost an owner the
    // other 37 — the pass reports it in `failed` and carries on.
    try { out.push({ key, result: await RULES[key](db, owner, { now }) }); }
    catch (err) { onError?.(owner, key, err); }
  }
  return out;
}

type Names = { ownerName: string; clanTag: string | null; factionId: number | null; serverId: number; memberDiscordId: string | null };

async function namesFor(db: Database, owner: Owner, serverIdHint?: number): Promise<Names> {
  if (owner.kind === "clan") {
    const [f] = await db.select({ tag: factions.tag, name: factions.name, serverId: factions.serverId }).from(factions).where(eq(factions.id, Number(owner.id)));
    return { ownerName: f?.name ?? owner.id, clanTag: f?.tag ?? null, factionId: Number(owner.id), serverId: f?.serverId ?? serverIdHint ?? 0, memberDiscordId: null };
  }
  const [link] = await db.select({ discordId: identityLinks.discordId, gamertag: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.dayzId, owner.id));
  const [seen] = link ? [] : await db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, owner.id));
  const [m] = await db.select({ factionId: factionMembers.factionId, tag: factions.tag, serverId: factions.serverId })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.dayzId, owner.id), eq(factionMembers.status, "full"), inArray(factions.status, [...HOLDING_STATUSES]))).orderBy(asc(factions.id)).limit(1);
  // The roster is authoritative, but a player can be off it and still have an OPEN
  // membership span (the reconciler writes membership_history once per tick, and the
  // rules themselves read it). Fall back to the span so a clanmate's unlock still
  // reaches the clan channel instead of silently going nowhere.
  const [h] = m ? [] : await db.select({ factionId: membershipHistory.factionId, tag: factions.tag, serverId: membershipHistory.serverId })
    .from(membershipHistory).innerJoin(factions, eq(factions.id, membershipHistory.factionId))
    .where(and(eq(membershipHistory.dayzId, owner.id), isNull(membershipHistory.leftAt), inArray(factions.status, [...HOLDING_STATUSES])))
    .orderBy(asc(membershipHistory.joinedAt)).limit(1);
  const clanRow = m ?? h;
  let serverId = serverIdHint ?? clanRow?.serverId;
  // ⚠️ `server_id` is a FK on clan_notices: a zero here aborts the whole owner's
  // transaction, losing its unlock rows too. Prefer the live server, then any server.
  if (!serverId) { const [s] = await db.select({ id: servers.id }).from(servers).where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId))).orderBy(asc(servers.id)).limit(1); serverId = s?.id; }
  if (!serverId) { const [s] = await db.select({ id: servers.id }).from(servers).orderBy(asc(servers.id)).limit(1); serverId = s?.id ?? 0; }
  return {
    // ⚠️ A LINKED player's name is their Discord id, not their gamertag: notice-text's
    // `person()` renders an all-digit value as a mention, which is how the player is
    // actually told. The gamertag is the fallback for someone who never linked.
    ownerName: link?.discordId ?? seen?.gamertag ?? "a player",
    clanTag: clanRow?.tag ?? null,
    factionId: clanRow?.factionId ?? null,
    serverId,
    memberDiscordId: link?.discordId ?? null,
  };
}

/** Evaluate one owner and commit its progress, unlocks and notices together. */
async function processOwner(
  db: Database, owner: Owner, now: Date, announce: boolean,
  opts: AchievementsTickOpts, result: AchievementsTickResult, onError: AchievementsTickOpts["onError"],
): Promise<void> {
  const evaluated = await evaluateOwner(db, owner, now, onError);
  result.evaluated += 1;
  // One transaction per owner: the unlock rows, the progress cache and the notices
  // commit together, so a notice can never describe an unlock that did not land (or
  // the reverse). Lock order §4.12: clan_notices is last, and it is.
  await db.transaction(async (tx) => {
    const existing = new Set((await tx.select({ key: achievementUnlocks.key }).from(achievementUnlocks)
      .where(and(eq(achievementUnlocks.ownerKind, owner.kind), eq(achievementUnlocks.ownerId, owner.id)))).map((r) => r.key));
    let names: Names | undefined;
    for (const { key, result: r } of evaluated) {
      await tx.insert(achievementProgress).values({ ownerKind: owner.kind, ownerId: owner.id, key, count: r.count, target: r.target, computedAt: now })
        .onConflictDoUpdate({ target: [achievementProgress.ownerKind, achievementProgress.ownerId, achievementProgress.key], set: { count: r.count, target: r.target, computedAt: now } });
      if (r.count < r.target || existing.has(key) || !r.earnedAt) continue;
      const inserted = await tx.insert(achievementUnlocks).values({ ownerKind: owner.kind, ownerId: owner.id, key, earnedAt: r.earnedAt, evidenceId: r.evidenceId ?? null, evidence: r.evidence ?? {} })
        .onConflictDoNothing().returning({ key: achievementUnlocks.key });
      // ⚠️ No rows back means the row already existed — a concurrent pass won, and it
      // queued the notices. Queueing them here too is a duplicate DM to a real player.
      if (!inserted.length) continue;
      result.unlocked += 1;
      if (!announce) continue;
      names ??= await namesFor(db, owner, r.serverId);
      const a = ACHIEVEMENT_BY_KEY[key];
      const payload = { key, name: a.name, description: a.description, ownerKind: owner.kind, ownerName: names.ownerName, clanTag: names.clanTag };
      const base = { serverId: names.serverId, kind: "achievement" as const, occurredAt: r.earnedAt, payload };
      if (owner.kind === "clan") {
        await noticeClanTx(tx, { ...base, factionId: names.factionId! });
        await noticeFullMembersTx(tx, { ...base, factionId: names.factionId! });
      } else {
        if (names.factionId) await noticeClanTx(tx, { ...base, factionId: names.factionId });
        if (names.memberDiscordId) await noticeUserTx(tx, { ...base, factionId: names.factionId, discordId: names.memberDiscordId });
      }
      if (opts.achievementsChannelId) {
        // The public wall: a channel notice with no clan behind it, so the target is
        // written in rather than resolved from a faction row by the poster.
        await appendClanNoticeTx(tx, { ...base, factionId: null, target: "channel", discordTargetId: opts.achievementsChannelId, payload: { ...payload, public: true } });
      }
    }
  });
}

/**
 * Walk every position and pin past the watermarks, in id order, in chunks, feeding the
 * counters. Used by the backfill, which must not head those watermarks over history it
 * never counted — a backfilled explorer would sit at 0 squares forever after.
 */
async function backfillCounters(db: Database, wm: Watermarks, chunk: number): Promise<void> {
  for (let after = wm.positions; ;) {
    const rows = await positionsAfter(db, after, chunk);
    if (!rows.length) break;
    await db.transaction((tx) => applyPositionCounters(tx, rows));
    after = rows[rows.length - 1]!.id;
    if (rows.length < chunk) break;
  }
  for (let after = wm.pins; ;) {
    const rows = await pinsAfter(db, after, chunk);
    if (!rows.length) break;
    await db.transaction((tx) => applyPinCounters(tx, rows));
    after = rows[rows.length - 1]!.id;
    if (rows.length < chunk) break;
  }
}

/**
 * One pass of the achievements engine.
 *
 * ⚠️ One caller at a time. Two passes racing (or a backfill running beside the live tick)
 * share the watermarks and the resume marker, so they will re-evaluate and skip each
 * other's owners; the unlock primary key keeps that harmless but not complete. The runbook
 * disables the live tick for the duration of a backfill — that is the whole interlock.
 */
export async function achievementsTick(db: Database, opts: AchievementsTickOpts): Promise<AchievementsTickResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 200;
  const announce = opts.announce ?? true;
  const result: AchievementsTickResult = { evaluated: 0, unlocked: 0, carried: 0, failed: 0 };
  const onError: AchievementsTickOpts["onError"] = (o, k, e) => { result.failed += 1; opts.onError?.(o, k, e); };
  // ⚠️ Spec §6.2: one owner's failure never blocks another's. `evaluateOwner` already isolates
  // a throwing RULE, but the COMMIT can throw too — an FK on a notice's server_id, a jsonb the
  // driver cannot serialise, a deadlock. Unguarded, that throw leaves `achievementsTick` before
  // the watermarks and the resume marker are written, so the next pass collects the same owner
  // and dies on it again: one poisoned owner stalls the whole engine, silently and for good
  // (and on the backfill path it abandons the drain half-done, then heads nothing). Key "*"
  // means "the owner, not a rule" to the caller's error sink.
  const runOwner = async (owner: Owner) => {
    try { await processOwner(db, owner, now, announce, opts, result, onError); }
    catch (err) { onError(owner, "*" as AchievementKey, err); }
  };
  const wm = await readWatermarks(db);

  if (opts.everyone) {
    // ⚠️ A backfill drains EVERY owner within this one call. It ends by heading the
    // watermarks, so an owner it skipped is unreachable afterwards: the live tick only
    // ever looks at rows past those heads. `batch` only bounds how many owners are held
    // in flight, never how many are done.
    // ⚠️ The heads are read FIRST, before a single row is counted or an owner evaluated,
    // and it is these — not the heads at the end — that are written when the backfill is
    // done. A backfill takes minutes, and players keep dropping pins and moving through the
    // web app while it runs; heading the watermarks over rows the backfill never saw would
    // lose those pins and fixes for good, because the live tick only ever looks past the
    // heads. Taken first, they stay unread and the next live pass picks them up.
    const heads = await headWatermarks(db);
    await backfillCounters(db, wm, batch * 5);
    const all = [...(await collectEveryone(db))].sort((a, b) => ownerKey(a).localeCompare(ownerKey(b)));
    for (const owner of all) await runOwner(owner);
    await db.transaction(async (tx) => { await writeWatermarks(tx, heads); await clearResume(tx); });
    return result;
  }

  const resume = await readResume(db);
  const touched = await collectTouched(db, wm, batch * 5);
  // Counters first, in their own transaction: the rules for explorer/cartographer read them.
  if (touched.positions.length || touched.pins.length) {
    await db.transaction(async (tx) => { await applyPositionCounters(tx, touched.positions); await applyPinCounters(tx, touched.pins); });
  }
  // Resume strictly after the last owner the drain processed — a key, not an index, so a
  // newly touched owner sorting earlier cannot push a different one out of the list.
  const pending = resume ? touched.owners.filter((o) => ownerKey(o) > resume.afterKey) : touched.owners;
  const owners = pending.slice(0, batch);
  const ownersLeft = pending.length - owners.length;
  // Backlog, for the operator: owners this pass did not reach, plus one for "and at least
  // one source had more rows than it was allowed to read" — those unread rows are owners
  // the next pass will find. Only `ownersLeft` decides whether the drain continues.
  result.carried = ownersLeft + (touched.carried ? 1 : 0);

  for (const owner of owners) await runOwner(owner);

  // ⚠️ Computed BEFORE the transaction: an `await` cannot live in the non-async arrow the
  // watermark write would otherwise be. A finished drain advances to the watermarks it
  // STARTED from, never the latest collect's — rows that arrived mid-drain belong to the
  // next pass, and consuming them here would drop their owners on the floor.
  const finalWm: Watermarks = resume?.wm ?? touched.next;
  await db.transaction(async (tx) => {
    if (ownersLeft === 0) { await writeWatermarks(tx, finalWm); await clearResume(tx); }
    else await writeResume(tx, { afterKey: ownerKey(owners[owners.length - 1]!), wm: finalWm });
  });
  return result;
}
