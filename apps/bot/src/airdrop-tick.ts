import { airdropEvents, playerSessions, servers, type Database } from "@factions/db";
import {
  AIRDROP_HISTORY_MS, chooseAirdrop, decisionInstantFor, isoWeekStart, nextRestartAt, p90,
  RESTART_PERIOD_MS, shouldFire,
} from "@factions/domain";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { airdropText } from "./airdrop-text.js";

export type AirdropPoster = (content: string) => Promise<void>;
export type AirdropTickResult = { decided: number; posted: number; failed: number };

/**
 * Players connected at `instant`, from the session spans (spec §2's
 * reconstruction, as a single statement per instant set).
 */
async function popsAt(db: Database, serverId: number, instants: Date[]): Promise<number[]> {
  if (instants.length === 0) return [];
  const rows = await db.execute<{ t: Date; c: number }>(sql`
    select t, (
      select count(*)::int from player_sessions s
      where s.server_id = ${serverId}
        and s.connected_at <= t
        and (s.disconnected_at is null or s.disconnected_at > t)
    ) as c
    from unnest(array[${sql.join(instants.map((d) => sql`${d.toISOString()}::timestamptz`), sql`, `)}]) as t
  `);
  return [...rows].map((r) => Number(r.c));
}

/**
 * Decide and announce (spec §3, §8). Runs every tick; does nothing until the first
 * tick at or after T-30min before a slot.
 *
 * ⚠️ Row FIRST, post second — the opposite of every other poster here, and it is
 * spec §9 that reverses it. Posting first and crashing before the row leaves a drop
 * players were told about that nothing will ever enable. Writing first and failing
 * the post leaves a row whose `announced_at` is null, which the enable query in
 * `restart-tick.ts` refuses to act on: the harmless direction.
 */
export async function airdropTick(
  db: Database, post: AirdropPoster,
  opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number },
): Promise<AirdropTickResult> {
  const out: AirdropTickResult = { decided: 0, posted: 0, failed: 0 };
  const rng = opts.rng ?? Math.random;
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));

  for (const s of targets) {
    try {
      const slot = nextRestartAt(opts.now);

      // 1. An earlier decision that has not been announced yet: retry the post
      //    while its slot is still ahead, and scrub it once the slot has passed.
      const pending = await db.select().from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), eq(airdropEvents.state, "announced"), isNull(airdropEvents.announcedAt),
      ));
      for (const row of pending) {
        if (row.slotAt.getTime() <= opts.now.getTime()) {
          // ⚠️ The slot it was for has come and gone with nobody told. Fail it and
          // refund the budget rather than announcing a drop for the wrong session.
          await db.update(airdropEvents).set({ state: "failed", endedAt: opts.now, detail: { reason: "never announced" } })
            .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, row.slotAt)));
          out.failed += 1;
          continue;
        }
        try {
          await post(airdropText(row.location, row.slotAt));
          await db.update(airdropEvents).set({ announcedAt: opts.now })
            .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, row.slotAt)));
          out.posted += 1;
        } catch (err) {
          console.warn(`airdrop: announcement for ${row.slotAt.toISOString()} failed to post — retrying next tick`, err);
        }
      }
      if (pending.length > 0) continue;

      // 2. A new decision, at or after T-30min and not yet taken for this slot.
      if (opts.now < decisionInstantFor(slot)) continue;
      const [already] = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents)
        .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slot))).limit(1);
      if (already) continue;

      const open = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), inArray(airdropEvents.state, ["announced", "live"]),
      ));
      // ⚠️ `failed` rows are excluded from BOTH counts: spec §9 refunds the budget,
      // and a scrubbed drop is not one the server ever had.
      // ⚠️ `manual` rows are excluded from THIS count only. An admin placing a drop
      // by hand is not spending the automatic budget — but the `last` lookup and the
      // `open` guard below both still see it, so a hand-placed drop does hold the
      // 24h gap and does stop a second drop being decided on top of it.
      const week = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), ne(airdropEvents.state, "failed"),
        eq(airdropEvents.manual, false),
        gte(airdropEvents.decidedAt, isoWeekStart(opts.now)),
      ));
      const [last] = await db.select({ decidedAt: airdropEvents.decidedAt }).from(airdropEvents)
        .where(and(eq(airdropEvents.serverId, s.id), ne(airdropEvents.state, "failed")))
        .orderBy(sql`${airdropEvents.decidedAt} desc`).limit(1);

      // The trailing history: every decision instant on the slot grid, 14 days back.
      const instants: Date[] = [];
      for (let t = decisionInstantFor(slot).getTime() - AIRDROP_HISTORY_MS;
           t < decisionInstantFor(slot).getTime(); t += RESTART_PERIOD_MS) {
        instants.push(new Date(t));
      }
      const [pop] = await popsAt(db, s.id, [opts.now]);
      const threshold = p90(await popsAt(db, s.id, instants));

      if (!shouldFire({
        pop: pop ?? 0, threshold, minPop: opts.minPop, weekCount: week.length,
        weeklyCap: opts.weeklyCap, lastFireAt: last?.decidedAt ?? null,
        openEvent: open.length > 0, now: opts.now,
      })) continue;

      const recent = await db.select({ location: airdropEvents.location }).from(airdropEvents)
        .where(eq(airdropEvents.serverId, s.id)).orderBy(sql`${airdropEvents.decidedAt} desc`).limit(5);
      const spec = chooseAirdrop(recent.map((r) => r.location), rng);

      await db.insert(airdropEvents).values({
        // ⚠️ `chooseAirdrop` returns a plain `string` (it draws from `AIRDROP_COLOURS`,
        // which the schema's CHECK constraint already restricts to the same three
        // values) — the cast doesn't widen what can land in the column.
        serverId: s.id, slotAt: slot, location: spec.location, colour: spec.colour as "blue" | "orange" | "yellow",
        decidedAt: opts.now, popAtDecision: pop ?? 0, threshold: String(threshold), state: "announced",
      }).onConflictDoNothing();
      out.decided += 1;
      console.log(`airdrop: server ${s.id} decided ${spec.location}/${spec.colour} for ${slot.toISOString()} (pop ${pop}, threshold ${threshold.toFixed(2)})`);

      try {
        await post(airdropText(spec.location, slot));
        await db.update(airdropEvents).set({ announcedAt: opts.now })
          .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slot)));
        out.posted += 1;
      } catch (err) {
        // ⚠️ Left `announced` with a null announced_at, NOT failed outright: the
        // slot is still up to 30 minutes away, and the tick runs roughly every 10
        // seconds, so the retry loop above (branch 1) gets on the order of 180 more
        // attempts inside the window before this drop is written off. A transient
        // Discord failure (rate limit, blip) is exactly what that budget is for.
        // "Fixing" this to fail fast here would make branch 1 nearly dead code —
        // reachable only by a process crash between the insert above and this post —
        // and would spend a whole week's cap on a hiccup that a retry ten seconds
        // later would have cleared. The refund still happens: once the slot itself
        // arrives with `announced_at` still null, branch 1's other arm marks the row
        // `failed` and it drops out of the weekly count from then on.
        console.warn(`airdrop: announcement for ${slot.toISOString()} failed to post — retrying next tick`, err);
      }
    } catch (err) {
      console.error(`airdrop: server ${s.id} decision failed`, err);
    }
  }
  return out;
}
