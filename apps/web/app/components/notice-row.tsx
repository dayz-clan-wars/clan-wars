import type { NoticeRow } from "@factions/roster";
import { noticeCopy } from "@/lib/notice-copy";

/**
 * One notification, on the page and in the bell panel.
 *
 * ⚠️ Unread is said in WORDS as well as in colour. A dot and a lighter
 * background are the whole signal otherwise, and neither reaches a screen
 * reader or survives a colour-blind player.
 */

/**
 * Kinds that are an outstanding obligation — a challenge pending or expired,
 * and nothing else (globals.css: `--color-rust` means exactly that, never a
 * generic "bad news" colour). `ban_applied` and `zone_warning` are notable but
 * nothing the player can discharge, so they stay off this set; ALARM_WEIGHT
 * below gives them a cue that isn't rust.
 */
const ALARM = new Set(["flag_down", "disband_warning", "solo_lapsed"]);

/** Kinds worth standing out even though they are not an obligation — weight, not colour. */
const ALARM_WEIGHT = new Set(["ban_applied", "zone_warning"]);

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
  const c = noticeCopy(row.kind, row.payload, row.target);
  const alarm = ALARM.has(row.kind);
  const weighted = ALARM_WEIGHT.has(row.kind);
  const kicker = alarm ? "text-rust-2" : row.unread ? "text-gold" : weighted ? "font-black text-ink" : "text-dim";
  return (
    <article className={`flex gap-3.5 border-b border-rule px-4 py-4 lg:px-[18px] ${row.unread ? "bg-surface" : ""}`}>
      <span aria-hidden="true" className={`mt-[7px] h-[7px] w-[7px] flex-none ${row.unread ? (alarm ? "bg-rust-2" : "bg-gold") : "bg-transparent"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3.5 gap-y-1.5">
          <span className={`font-mono text-[10px] font-bold uppercase tracking-[0.16em] ${kicker}`}>
            {c.kicker}{row.unread && <span className="sr-only"> (Unread)</span>}
          </span>
          <time dateTime={row.occurredAt.toISOString()} className="font-mono text-[10px] tracking-[0.1em] text-dim">
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
