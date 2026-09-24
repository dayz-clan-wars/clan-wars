import { kothEvents, servers, serverRestarts, type Database } from "@factions/db";
import { KOTH_REMINDER_LEAD_MS, kothLocation, restartSlot } from "@factions/domain";
import { and, eq, lt, sql } from "drizzle-orm";
import { cancelledText, kothPrize, liveText, reminderText, resultsText } from "./koth-text.js";
import { scoreAndAward, scoringReady } from "./koth-score.js";

export type KothPosters = { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> };
type Row = typeof kothEvents.$inferSelect;
const town = (r: Row) => kothLocation(r.location)?.name ?? r.location;

/** Post, THEN stamp — a stamp first silences a post that never went out. */
async function postThen(post: (c: string) => Promise<void>, content: string, stamp: () => Promise<unknown>, what: string): Promise<boolean> {
  try { await post(content); } catch (err) { console.warn(`koth: ${what} failed to post — retrying next tick`, err); return false; }
  await stamp();
  return true;
}

/**
 * Everything King of the Hill says, and the scoring (spec §6, §8).
 *
 * ⚠️ Runs AFTER the restart tick in discord.ts: a slow Discord call must never
 * delay a due restart, which is why none of this lives in restart-tick.ts.
 */
export async function kothTick(db: Database, posters: KothPosters, opts: { now: Date; siteBaseUrl: string }) {
  const out = { posted: 0, failed: 0, scored: 0 };
  const slot = restartSlot(opts.now);
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      // 1. ⚠️ Never late (spec §2.1): an opening the restart tick did not reach is over.
      const [cur] = await db.select({ outcome: serverRestarts.outcome }).from(serverRestarts)
        .where(and(eq(serverRestarts.serverId, s.id), eq(serverRestarts.scheduledFor, slot.start))).limit(1);
      const missed = await db.update(kothEvents).set({ state: "failed", detail: sql`${kothEvents.detail} || '{"failure":"missed opening"}'::jsonb` })
        .where(and(eq(kothEvents.serverId, s.id), eq(kothEvents.state, "scheduled"),
          cur && cur.outcome !== "restarted"
            ? sql`${kothEvents.slotAt} <= ${slot.start.toISOString()}::timestamptz`
            : lt(kothEvents.slotAt, slot.start)))
        .returning({ id: kothEvents.id });
      out.failed += missed.length;

      const rows = await db.select().from(kothEvents).where(eq(kothEvents.serverId, s.id));
      for (const r of rows) {
        const set = (v: Partial<Row>) => db.update(kothEvents).set(v).where(eq(kothEvents.id, r.id));
        // 2. Reminder.
        if (r.state === "scheduled" && r.announcedAt && !r.remindedAt
            && opts.now.getTime() >= r.slotAt.getTime() - KOTH_REMINDER_LEAD_MS && opts.now < r.slotAt) {
          if (await postThen(posters.announce, reminderText(town(r), r.slotAt, kothPrize(r.awardKey)), () => set({ remindedAt: opts.now }), "reminder")) out.posted += 1;
        }
        // 3. Live.
        if (r.state === "live" && !r.livePostedAt) {
          if (await postThen(posters.announce, liveText(town(r), kothPrize(r.awardKey)), () => set({ livePostedAt: opts.now }), "live post")) out.posted += 1;
        }
        // 4. Score. ⚠️ Own try/catch: `scoreAndAward` throws DELIBERATELY on a refused
        // grant (so its transaction rolls back and the next tick retries) — letting that
        // propagate out of this loop would skip every other row on the server, and skip
        // steps 5–7 entirely, every tick, silently. A stuck row must never block a
        // different one (the house rule, notice-tick.ts).
        try {
          if (r.state === "live" && await scoringReady(db, r, opts.now)) {
            const res = await scoreAndAward(db, r.id, { now: opts.now, siteBaseUrl: opts.siteBaseUrl });
            if (res !== "skipped") out.scored += 1;
          }
        } catch (err) {
          console.error(`koth: scoring row ${r.id} failed — retrying next tick`, err);
        }
      }
      // 5–7 re-read, so a row scored above posts its results this same tick.
      for (const r of await db.select().from(kothEvents).where(eq(kothEvents.serverId, s.id))) {
        const set = (v: Partial<Row>) => db.update(kothEvents).set(v).where(eq(kothEvents.id, r.id));
        // ⚠️ Own try/catch per row, same reason as step 4: a DB error stamping one row's
        // post (or a rejected poster promise past `postThen`'s own catch) must not stop
        // a sibling row's results/cancel post or the ops alerts below it.
        try {
          if ((r.state === "awarded" || r.state === "no_winner" || r.state === "finished") && r.results && !r.resultsPostedAt) {
            // `finished` WITH a key is a prize scoring could not grant (koth-score.ts).
            const withheld = r.state === "finished" && r.awardKey !== null;
            if (await postThen(posters.announce, resultsText(town(r), r.results, kothPrize(r.awardKey), withheld), () => set({ resultsPostedAt: opts.now }), "results")) out.posted += 1;
          }
          // ⚠️ Only an event players were TOLD about gets a cancellation.
          if ((r.state === "cancelled" || r.state === "failed") && r.announcedAt && !r.cancelPostedAt) {
            if (await postThen(posters.announce, cancelledText(town(r), r.slotAt), () => set({ cancelPostedAt: opts.now }), "cancellation")) out.posted += 1;
          }
          const d = r.detail as Record<string, unknown>;
          // `failed`, or `finished` with a prize scoring could not grant.
          if ((r.state === "failed" || r.state === "finished") && d.failure && !d.opsAlerted) {
            const what = r.state === "failed" ? "failed" : "needs an admin";
            await postThen(posters.ops, `⚠️ King of the Hill at ${town(r)} (${r.slotAt.toISOString()}) ${what}: ${d.failure}`,
              () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || '{"opsAlerted":true}'::jsonb` }).where(eq(kothEvents.id, r.id)), "ops alert");
          }
          if (typeof d.restoreError === "string" && d.restoreError !== d.restoreErrorAlerted) {
            await postThen(posters.ops, `⚠️ King of the Hill could not restore every default file: ${d.restoreError}`,
              () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreErrorAlerted: d.restoreError })}::jsonb` }).where(eq(kothEvents.id, r.id)), "restore alert");
          }
        } catch (err) {
          console.error(`koth: results/cancel/ops posting for row ${r.id} failed — retrying next tick`, err);
        }
      }
    } catch (err) {
      console.error(`koth: server ${s.id} tick failed`, err);
    }
  }
  return out;
}
