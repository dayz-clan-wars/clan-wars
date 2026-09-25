import { notificationsFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { redirect } from "next/navigation";
import { NOTICE_GROUPS, noticeGroup, type NoticeGroup } from "@/lib/notice-copy";
import { notificationsHref, noticeDay } from "@/lib/notifications-page";
import { NoticeArticle } from "@/app/components/notice-row";
import { Pager, Notice, SubmitButton, btnSecondary } from "@/app/components/ui";
import { NoticeActions } from "./actions";
import { FilterChips } from "./filter-chips";
import { RESULT_COPY } from "@/lib/clan-copy";
import { LEADERSHIP_RESULT_COPY } from "@/lib/leadership-copy";
import { NOTIFICATIONS_RESULT_COPY } from "@/lib/notifications-copy";
import { lookupCopy } from "@/lib/copy-lookup";

/**
 * Everything the bot has told you, and everything it told your clan since you
 * joined it (spec §3). The clan half is why this page is not simply your DMs.
 *
 * ⚠️ Request-time rendered like the rest of the group; the session decides
 * every row, so there is nothing here to cache.
 */
export const dynamic = "force-dynamic";

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ page?: string; group?: string; result?: string }> }) {
  const session = await currentSession();
  // The middleware admitted this request, so the cookie was valid a moment ago; sign in again rather than land nowhere.
  if (!session) redirect("/login?next=/notifications");
  const q = await searchParams;
  const page = Math.max(1, Number(q.page ?? "1") || 1);
  const group = NOTICE_GROUPS.find((g) => g === q.group);
  const notice = q.result
    ? (lookupCopy(RESULT_COPY, q.result) ?? lookupCopy(LEADERSHIP_RESULT_COPY, q.result) ?? lookupCopy(NOTIFICATIONS_RESULT_COPY, q.result))
    : undefined;

  const feed = await notificationsFor(session.sub, page);
  const now = new Date();
  const shown = group ? feed.rows.filter((r) => noticeGroup(r.kind) === group) : feed.rows;

  // Day headings are computed per page on purpose: a day spanning a page
  // boundary gets its heading on both, which beats a pager that cannot say how
  // many pages there are.
  const days = ["Today", "Yesterday", "Earlier"]
    .map((day) => ({ day, items: shown.filter((r) => noticeDay(r.occurredAt, now) === day) }))
    .filter((d) => d.items.length > 0);

  const href = (o: { page?: number; group?: NoticeGroup | null }) => notificationsHref({ page, group }, o);

  return (
    <main id="main" tabIndex={-1} className="max-w-[900px] px-4 pb-20 pt-10 outline-none lg:px-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-3">
        <h1 className="m-0 font-display text-[34px] uppercase tracking-[0.02em] text-ink">Notifications</h1>
        <form action="/api/notifications/read-all" method="post">
          <SubmitButton className={btnSecondary}>Mark all read</SubmitButton>
        </form>
      </div>
      <p className="mt-2.5 max-w-[62ch] text-sm leading-relaxed text-muted text-pretty">
        Everything the bot sent you, and everything it posted to your clan since you joined.
      </p>

      {notice && <Notice>{notice}</Notice>}

      <FilterChips group={group} href={href} />

      {days.length === 0 ? (
        <p className="mt-9 border-2 border-rule-2 bg-frame px-4 py-8 text-center text-sm text-muted">
          {group ? "Nothing in this filter on this page." : "Nothing here yet."}
        </p>
      ) : days.map((d) => (
        <section key={d.day} className="mt-9">
          <h2 className="m-0 mb-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-dim">{d.day}</h2>
          <div className="border-t-2 border-rule-2">
            {d.items.map((r) => <NoticeArticle key={r.id} row={r} now={now} actions={<NoticeActions row={r} />} />)}
          </div>
        </section>
      ))}

      {(feed.page > 1 || feed.hasNext) && (
        <Pager page={feed.page} prevHref={feed.page > 1 ? href({ page: feed.page - 1 }) : null}
               nextHref={feed.hasNext ? href({ page: feed.page + 1 }) : null}
               labels={{ prev: "Newer", next: "Older", page: (n) => `Page ${n}` }} />
      )}
    </main>
  );
}
