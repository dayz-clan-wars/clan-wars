import type { NoticeStore } from "@factions/roster/internal";
import { NOTICE_MAX_ATTEMPTS } from "@factions/roster/internal";
import type { NoticeTarget } from "@factions/domain";
import { noticeText } from "./notice-text.js";

export type NoticeSender = (target: NoticeTarget, discordTargetId: string, content: string) => Promise<void>;

export type NoticeTickResult = { posted: number; failed: number; blockedTargets: string[] };

/**
 * Post queued `clan_notices` rows, oldest first, per target (spec §9.3/§9.4).
 *
 * ⚠️ Order is preserved PER TARGET, not globally: a channel is read
 * top-down, so a stuck row must block only what comes after it in that same
 * channel or DM — a different target's queue is unrelated and must not wait
 * behind it (unlike the feed, which has exactly one channel and therefore
 * one queue).
 *
 * ⚠️ Three attempts, then the row is marked failed and stops being read —
 * `NOTICE_MAX_ATTEMPTS`, shared with `PgNoticeStore.markAttempt`. A failed
 * row does not block the rows behind it forever: only the CURRENT tick's
 * attempt blocks that target, so a later, healthy row for the same target
 * posts on the next tick.
 */
export async function noticeTick(
  store: NoticeStore,
  send: NoticeSender,
  opts: { now: Date; batchSize?: number; onError?: (id: number, attempts: number, err: unknown) => void },
): Promise<NoticeTickResult> {
  const rows = await store.readUnposted(opts.batchSize ?? 50);
  const blocked = new Set<string>();
  const out: NoticeTickResult = { posted: 0, failed: 0, blockedTargets: [] };

  for (const row of rows) {
    const target = row.discordTargetId!;
    if (blocked.has(target)) continue;
    try {
      await send(row.target, target, noticeText(row, opts.now));
      await store.markPosted(row.id, opts.now);
      out.posted++;
    } catch (err) {
      const attempts = await store.markAttempt(row.id, opts.now);
      opts.onError?.(row.id, attempts, err);
      if (attempts >= NOTICE_MAX_ATTEMPTS) out.failed++;
      blocked.add(target);
    }
  }

  out.blockedTargets = [...blocked];
  return out;
}
