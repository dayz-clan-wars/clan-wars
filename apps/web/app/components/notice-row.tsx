import type { NoticeRow } from "@factions/roster";
import { noticeCopy } from "@/lib/notice-copy";

/**
 * One notification, on the page and in the bell panel.
 *
 * ⚠️ Unread is said in WORDS as well as in colour. A dot and a lighter
 * background are the whole signal otherwise, and neither reaches a screen
 * reader or survives a colour-blind player.
 */

/** Kinds that are bad news. They take the rust kicker so a long page can be skimmed for trouble. */
const ALARM = new Set(["ban_applied", "zone_warning", "flag_down", "disband_warning", "solo_lapsed"]);

/** "12m", "3h", "Mon" — coarse, because a notice is not a countdown. */
export function noticeAge(at: Date, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function NoticeArticle({ row, actions, now = new Date() }: {
  row: NoticeRow; actions?: React.ReactNode; now?: Date;
}) {
  const c = noticeCopy(row.kind, row.payload);
  const alarm = ALARM.has(row.kind);
  const kicker = alarm ? "text-rust-2" : row.unread ? "text-gold" : "text-dim";
  return (
    <article className={`flex gap-3.5 border-b border-rule px-4 py-4 lg:px-[18px] ${row.unread ? "bg-surface" : ""}`}>
      <span aria-hidden="true" className={`mt-[7px] h-[7px] w-[7px] flex-none ${row.unread ? (alarm ? "bg-rust-2" : "bg-gold") : "bg-transparent"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-1.5">
          <span className={`font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${kicker}`}>
            {c.kicker}{row.unread && <span className="sr-only"> (Unread)</span>}
          </span>
          {/*
            ⚠️ Lowercase `datetime` on purpose. React's SSR renderer has no
            attribute-name mapping for `dateTime` (unlike `className`/
            `tabIndex`), so the camelCase prop is emitted VERBATIM as
            `dateTime="…"` in the markup string — parses fine in a real
            browser (HTML attributes are case-insensitive) but is the wrong
            literal bytes for a test, or any other exact-string reader, that
            expects the spec's lowercase `datetime`. Passing it lowercase
            trips React's one-time "did you mean `dateTime`" dev warning
            (deduped process-wide) in exchange for the correct bytes.
          */}
          <time {...{ datetime: row.occurredAt.toISOString() }} className="font-mono text-[10px] tracking-[0.1em] text-dim">
            {noticeAge(row.occurredAt, now)}
          </time>
        </div>
        <p className={`mt-1.5 font-display text-sm tracking-[0.01em] text-pretty ${row.unread ? "text-ink" : "text-ink-2"}`}>{c.title}</p>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-ink-2 text-pretty">{c.body}</p>
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </article>
  );
}
