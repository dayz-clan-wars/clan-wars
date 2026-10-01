import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { AchievementBadge } from "@/app/components/achievement-badge";
import { flagThumbPath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { kicker } from "@/app/components/ui";
import type { LiveItem } from "@/lib/live-items";
import { Rich } from "./rich";

/** One feed entry. No hooks and no server-only imports, so a client list can render it too. */
export function LiveCardView({ item }: { item: LiveItem }) {
  const key = item.badge?.key as AchievementKey | undefined;
  const group = key ? ACHIEVEMENT_BY_KEY[key]?.group : undefined;
  return (
    <li className="flex gap-3 py-3">
      <div className="flex h-10 w-10 flex-none items-center justify-center">
        {item.flag ? (
          <img src={`/${flagThumbPath(item.flag)}`} alt="" loading="lazy" width={40} height={40} className="h-10 w-10 object-contain" />
        ) : key && group ? (
          <AchievementBadge achievementKey={key} group={group} state="unlocked" size={40} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {item.title && (
          <h3 className={`font-display ${item.tone === "warn" ? "text-rust" : "text-ink"}`}>
            {item.href ? <a href={item.href}><Rich line={item.title} /></a> : <Rich line={item.title} />}
          </h3>
        )}
        {item.lines.map((l, i) => <p key={i} className="text-ink-2"><Rich line={l} /></p>)}
        {item.detail.map((l, i) => <p key={i} className="font-mono text-xs text-muted"><Rich line={l} /></p>)}
        <time dateTime={item.at} className={kicker}>{when(new Date(item.at))}</time>
      </div>
    </li>
  );
}
