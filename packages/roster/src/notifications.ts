import type { Database } from "@factions/db";
import type { ClanNoticeKind, NoticeTarget } from "@factions/domain";
import { sql } from "drizzle-orm";
import type { NoticePayload } from "./internal/notices";

/** A page of the notifications list. 50 keeps the page one screen of scrolling per press. */
export const NOTIFICATIONS_PAGE_SIZE = 50;

export type NoticeRow = {
  id: number;
  kind: ClanNoticeKind;
  target: NoticeTarget;
  occurredAt: Date;
  payload: NoticePayload;
  /**
   * The clan this notice belongs to (null for a DM with none, e.g. an invite
   * withdrawn before the clan is known). Named `clanId`, not `factionId`, at
   * this boundary on purpose — `apps/web` never references an identifier
   * containing "faction" (copy-vocabulary.test.ts), and this is the field a
   * page reads to pick the RIGHT invite or clan out of live state rather than
   * guessing the first one (spec §5).
   */
  clanId: number | null;
  /** False once the watermark covers it or an individual read row exists. */
  unread: boolean;
};

export type NotificationsPage = { rows: NoticeRow[]; page: number; hasNext: boolean };

/**
 * Everything this viewer may read, as one ordered set (spec §3): the DMs
 * addressed to them, plus the channel notices of every clan they are currently
 * a FULL member of, from the moment they joined it.
 *
 * ⚠️ `status = 'full'` and the `joined_at` floor are not optimisations. A
 * pending member is on faction_members and NOT on the roster (that table's own
 * ⚠️), and without the floor, joining a clan hands you its entire history —
 * every kick, every demotion, every raid it lost.
 *
 * ⚠️ Membership is read live, so leaving a clan removes its rows from this
 * page. The notices themselves are untouched; rejoining restores visibility
 * from the new joined_at forward. Stated here because it will be reported as
 * data loss otherwise.
 */
const VISIBLE = (discordId: string) => sql`
  select n.id, n.kind, n.target, n.occurred_at, n.payload, n.faction_id
    from clan_notices n
   where n.target = 'dm' and n.discord_target_id = ${discordId}
  union all
  select n.id, n.kind, n.target, n.occurred_at, n.payload, n.faction_id
    from clan_notices n
    join faction_members m
      on m.faction_id = n.faction_id
     and m.discord_id = ${discordId}
     and m.status = 'full'
   where n.target = 'channel' and n.occurred_at >= m.joined_at
`;

/** Every notice strictly above the watermark with no individual read row. */
const UNREAD_PREDICATE = (discordId: string) => sql`
  v.id > coalesce((select through_id from notice_read_marks where discord_id = ${discordId}), 0)
  and not exists (select 1 from notice_reads r where r.discord_id = ${discordId} and r.notice_id = v.id)
`;

type Raw = {
  id: string; kind: ClanNoticeKind; target: NoticeTarget;
  occurred_at: string; payload: NoticePayload; faction_id: string | null; unread: boolean;
};

/**
 * `pageSize` defaults to `NOTIFICATIONS_PAGE_SIZE` (the page's own behaviour,
 * unchanged) but the bell only ever shows its newest four and used to fetch
 * a full 51-row page — payload JSONB and all — to throw away all but four of
 * them. Passing a smaller size here means the query itself does less work,
 * not just the slice after it.
 */
export async function notificationsForDb(db: Database, discordId: string, page: number, pageSize: number = NOTIFICATIONS_PAGE_SIZE): Promise<NotificationsPage> {
  const p = Math.max(1, Math.trunc(page));
  // ⚠️ One extra row, not a second COUNT query: "is there a next page" is the
  // only thing the pager needs, and counting an unbounded table to learn it is
  // the expensive way to answer a yes/no question.
  const limit = pageSize + 1;
  const offset = (p - 1) * pageSize;

  const raw = await db.execute<Raw>(sql`
    with v as (${VISIBLE(discordId)})
    select v.*, (${UNREAD_PREDICATE(discordId)}) as unread
      from v
     order by v.id desc
     limit ${limit} offset ${offset}
  `);

  const all = [...raw];
  const hasNext = all.length > pageSize;
  const rows = all.slice(0, pageSize).map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    target: r.target,
    occurredAt: new Date(r.occurred_at),
    payload: r.payload,
    clanId: r.faction_id === null ? null : Number(r.faction_id),
    unread: r.unread,
  }));
  return { rows, page: p, hasNext };
}

/** The bell's number. Same visibility rule as the page, counted rather than listed. */
export async function unreadNoticeCountDb(db: Database, discordId: string): Promise<number> {
  const [row] = await db.execute<{ n: string }>(sql`
    with v as (${VISIBLE(discordId)})
    select count(*) as n from v where ${UNREAD_PREDICATE(discordId)}
  `);
  return Number(row?.n ?? 0);
}

/**
 * "Mark all read": move the watermark to the highest notice this viewer can
 * currently see.
 *
 * ⚠️ Capped at the viewer's OWN maximum, never at `max(clan_notices.id)`. The
 * watermark is a bare id with no visibility of its own, so a global maximum
 * would mark the next notice addressed to this player read before it was
 * written — silently, and only for the player who pressed the button.
 */
export async function markAllNoticesReadDb(db: Database, discordId: string): Promise<void> {
  await db.execute(sql`
    with v as (${VISIBLE(discordId)}),
         top as (select coalesce(max(id), 0) as id from v)
    insert into notice_read_marks (discord_id, through_id)
    select ${discordId}, top.id from top where top.id > 0
    on conflict (discord_id) do update
      set through_id = greatest(notice_read_marks.through_id, excluded.through_id),
          marked_at = now()
  `);
}

/**
 * Mark one notice read — what an action does once it has resolved.
 *
 * ⚠️ Constrained to what the viewer can see, so a guessed id cannot be used to
 * probe whether a notice exists. Idempotent: pressing twice is one row.
 */
export async function markNoticeReadDb(db: Database, discordId: string, noticeId: number): Promise<void> {
  await db.execute(sql`
    with v as (${VISIBLE(discordId)})
    insert into notice_reads (discord_id, notice_id)
    select ${discordId}, v.id from v where v.id = ${noticeId}
    on conflict (discord_id, notice_id) do nothing
  `);
}
