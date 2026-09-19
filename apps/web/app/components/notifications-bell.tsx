import type { NoticeRow } from "@factions/roster";
import { NoticeArticle } from "./notice-row";

/**
 * The bell in the top bar and its panel.
 *
 * A `<details>`, like the phone drawer in menu-list.tsx, so it opens without
 * JavaScript and closes on navigation. No client JS here at all: unlike the
 * drawer, the bell needs no Escape/click-outside handling to be usable — it
 * is a small anchored panel, not a full-screen overlay stealing focus from
 * the rest of the page, so the plain `<details>` default (toggle on summary
 * click, no backdrop) is enough on its own.
 *
 * ⚠️ z-[1300] on the panel, for the same reason the bar carries it: Leaflet's
 * panes sit at 200-700, its controls at 1000, and the map page's sheets at
 * 1100-1200. A panel under any of them is unreachable from the page players
 * spend the most time on.
 */
export function NotificationsBell({ unread, recent, now = new Date() }: {
  unread: number; recent: NoticeRow[];
  /** ⚠️ Pass the page's own clock read here so the bell agrees with every other row on the page; only falls back to a fresh read when the caller has none. */
  now?: Date;
}) {
  return (
    <details className="group relative flex items-stretch border-l border-rule-2">
      <summary className={`flex h-full min-h-[44px] cursor-pointer list-none items-center px-4 [&::-webkit-details-marker]:hidden ${unread > 0 ? "text-ink" : "text-muted"} hover:text-gold`}>
        {/* ⚠️ A bare number beside a bell means nothing to a screen reader. Say what it counts, in words, as the accessible name — not a title attribute. */}
        <span className="sr-only">Notifications{unread > 0 ? `, ${unread} unread` : ", none unread"}</span>
        <svg width="22" height="22" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
          <path d="M14 3c-4 0-6.5 2.8-6.5 6.6 0 5.2-1.5 6.6-2.5 7.9h18c-1-1.3-2.5-2.7-2.5-7.9C20.5 5.8 18 3 14 3Z" />
          <path d="M11.5 21a2.6 2.6 0 0 0 5 0" />
        </svg>
        {unread > 0 && (
          // Purely decorative: the same count is already announced by the sr-only span above.
          <span aria-hidden="true" className="absolute right-2 top-2 inline-flex h-[18px] min-w-[18px] items-center justify-center bg-gold px-1.5 font-mono text-[11px] font-bold text-ground">{unread}</span>
        )}
      </summary>
      <div className="absolute right-0 top-[54px] z-[1300] w-[340px] max-w-[calc(100vw-24px)] border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)] lg:w-[400px]">
        <div className="flex items-center justify-between gap-3 border-b-2 border-rule-2 px-3.5 py-3">
          <span className="font-display text-xs uppercase tracking-[0.06em] text-ink">Notifications</span>
          {/* No `back` field: the route always lands on /notifications, and this panel
              has no reliable way to know the page it's open on top of without new
              plumbing (there's no pathname passed into SiteLayout today) — a hidden
              field carrying a hardcoded value would be exactly as dead as this was. */}
          <form action="/api/notifications/read-all" method="post">
            <button type="submit" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink">Mark all read</button>
          </form>
        </div>
        {recent.length === 0
          ? <p className="px-3.5 py-6 text-center text-sm text-muted">Nothing waiting.</p>
          // ⚠️ Pass the same `now` to every row, so every row in one render agrees — never a fresh new Date() per row.
          : recent.map((r) => <NoticeArticle key={r.id} row={r} now={now} />)}
        <a href="/notifications" className="flex min-h-[44px] items-center justify-center font-display text-xs uppercase tracking-[0.06em] text-gold">All notifications</a>
      </div>
    </details>
  );
}
