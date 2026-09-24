import { kothEvents, servers, serverRestarts, type Database } from "@factions/db";
import { KOTH_REMINDER_LEAD_MS, kothLocation, restartSlot } from "@factions/domain";
import { and, eq, lt, sql } from "drizzle-orm";
import { cancelledText, liveText, reminderText, resultsText } from "./koth-text.js";
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
          if (await postThen(posters.announce, reminderText(town(r), r.slotAt), () => set({ remindedAt: opts.now }), "reminder")) out.posted += 1;
        }
        // 3. Live.
        if (r.state === "live" && !r.livePostedAt) {
          if (await postThen(posters.announce, liveText(town(r)), () => set({ livePostedAt: opts.now }), "live post")) out.posted += 1;
        }
        // 4. Score.
        if (r.state === "live" && await scoringReady(db, r, opts.now)) {
          const res = await scoreAndAward(db, r.id, { now: opts.now, siteBaseUrl: opts.siteBaseUrl });
          if (res !== "skipped") out.scored += 1;
        }
      }
      // 5–7 re-read, so a row scored above posts its results this same tick.
      for (const r of await db.select().from(kothEvents).where(eq(kothEvents.serverId, s.id))) {
        const set = (v: Partial<Row>) => db.update(kothEvents).set(v).where(eq(kothEvents.id, r.id));
        if ((r.state === "awarded" || r.state === "no_winner") && r.results && !r.resultsPostedAt) {
          if (await postThen(posters.announce, resultsText(town(r), r.results), () => set({ resultsPostedAt: opts.now }), "results")) out.posted += 1;
        }
        // ⚠️ Only an event players were TOLD about gets a cancellation.
        if ((r.state === "cancelled" || r.state === "failed") && r.announcedAt && !r.cancelPostedAt) {
          if (await postThen(posters.announce, cancelledText(town(r), r.slotAt), () => set({ cancelPostedAt: opts.now }), "cancellation")) out.posted += 1;
        }
        const d = r.detail as Record<string, unknown>;
        if (r.state === "failed" && d.failure && !d.opsAlerted) {
          await postThen(posters.ops, `⚠️ King of the Hill at ${town(r)} (${r.slotAt.toISOString()}) failed: ${d.failure}`,
            () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || '{"opsAlerted":true}'::jsonb` }).where(eq(kothEvents.id, r.id)), "ops alert");
        }
        if (typeof d.restoreError === "string" && d.restoreError !== d.restoreErrorAlerted) {
          await postThen(posters.ops, `⚠️ King of the Hill could not restore every default file: ${d.restoreError}`,
            () => db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreErrorAlerted: d.restoreError })}::jsonb` }).where(eq(kothEvents.id, r.id)), "restore alert");
        }
      }
    } catch (err) {
      console.error(`koth: server ${s.id} tick failed`, err);
    }
  }
  return out;
}
