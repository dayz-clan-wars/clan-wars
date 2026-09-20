import type { NoticeStore } from "@factions/roster/internal";
import { NOTICE_MAX_ATTEMPTS } from "@factions/roster/internal";
import type { ClanNoticeKind, NoticeTarget } from "@factions/domain";
import type { APIEmbed } from "discord.js";
import { noticeText, noticeComponents } from "./notice-text.js";
import { achievementEmbed, achievementMention } from "./achievement-embed.js";

/** What one queued row posts: a line, an embed, or both (an achievement in a clan channel is a mention plus the card). `mentionRoleId` is set only when the line opens with that role's ping. */
export type NoticeMessage = { content: string; embeds?: APIEmbed[]; mentionRoleId?: string; components?: unknown[] };
export type NoticeSender = (target: NoticeTarget, discordTargetId: string, content: string, embeds?: APIEmbed[], mentionRoleId?: string, components?: unknown[]) => Promise<void>;

/**
 * The channel kinds that open with `<@&role>` so every clanmate's phone
 * buzzes: someone is at the base right now, or the flag is down. Everything
 * else posts silently and is read when the channel is next opened.
 *
 * ⚠️ Channel kinds ONLY. The `solo_*` twins are DM rows — a DM is already a
 * ping, and a solo player has no role to mention.
 *
 * ⚠️ A role ping is only audible if the role is mentionable or the bot holds
 * Mention Everyone; `structure-tick.ts` keeps every clan role mentionable for
 * exactly this reason. Without that, these lines render as grey text and
 * nobody is notified — a silent failure, since the message still posts.
 */
export const PING_KINDS: ReadonlySet<ClanNoticeKind> = new Set<ClanNoticeKind>([
  "intruder", "dismantle", "gate_built", "built",
  "flag_down", "non_member_raise", "colors_elsewhere",
]);

/**
 * An achievement posts as an embed (the badge, the group colour) rather than
 * the text line; every other kind is the line `noticeText` renders. In the
 * clan channel the embed rides behind a bare mention, so the player is still
 * pinged the way the text line pinged them — a DM needs no ping, and the
 * public wall never pinged anyone.
 */
export function noticeMessage(row: Parameters<typeof noticeText>[0] & { discordRoleId?: string | null }, now: Date, siteBaseUrl: string): NoticeMessage {
  if (row.kind !== "achievement") {
    const line = noticeText(row, now);
    // A clan with no role column yet (activation is mid-flight) still gets
    // the alert — unpinged beats undelivered.
    const roleId = row.target === "channel" && PING_KINDS.has(row.kind) ? row.discordRoleId ?? null : null;
    const components = noticeComponents(row);
    const base = roleId === null ? { content: line } : { content: `<@&${roleId}> ${line}`, mentionRoleId: roleId };
    return components ? { ...base, components } : base;
  }
  const mention = row.target === "channel" && !row.payload.public ? achievementMention(row.payload) : "";
  return { content: mention, embeds: [achievementEmbed(row.payload, siteBaseUrl)] };
}

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
 *
 * ⚠️ Delivery is AT-LEAST-ONCE, not exactly-once. The row is posted and THEN
 * marked, so a crash between `send()` and `markPosted` re-posts that row on
 * the next start. Discord has no idempotency key we could use, and the same
 * discipline is what `feedTick` has always had — a duplicate line is a much
 * smaller harm than a silently dropped one — but the queue is not a
 * guarantee of exactly one message.
 */
export async function noticeTick(
  store: NoticeStore,
  send: NoticeSender,
  opts: { now: Date; batchSize?: number; siteBaseUrl: string; onError?: (id: number, attempts: number, err: unknown) => void },
): Promise<NoticeTickResult> {
  const rows = await store.readUnposted(opts.batchSize ?? 50);
  const blocked = new Set<string>();
  const out: NoticeTickResult = { posted: 0, failed: 0, blockedTargets: [] };

  for (const row of rows) {
    const target = row.discordTargetId!;
    if (blocked.has(target)) continue;
    try {
      const msg = noticeMessage(row, opts.now, opts.siteBaseUrl);
      await send(row.target, target, msg.content, msg.embeds, msg.mentionRoleId, msg.components);
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
