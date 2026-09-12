import type { AchievementWall as Wall, AchievementTile } from "@factions/roster";
import { ACHIEVEMENT_GROUPS } from "@factions/domain";
import { GROUP_LABELS, WALL, progressLine, earnedLine } from "@/lib/achievements-copy";
import { Panel, PanelBody, kickerSm } from "@/app/components/ui";

/**
 * One achievement. A server component with no client JS: the bar is a width,
 * not a script, so the wall costs a page nothing.
 */
function Tile({ t }: { t: AchievementTile }) {
  const earned = t.earnedAt !== null;
  const progress = progressLine(t);
  const pct = earned ? 100 : Math.min(100, Math.round((t.count / t.target) * 100));
  return (
    <li className={`flex flex-col gap-1 border-2 px-3 py-2.5 ${earned ? "border-gold bg-frame" : "border-rule-2 bg-surface opacity-70"}`} aria-label={`${t.name}: ${earned ? earnedLine(t) : WALL.locked}`}>
      <span className={`font-display text-[13px] uppercase tracking-[0.06em] ${earned ? "text-gold" : "text-ink-2"}`}>{t.name}</span>
      <span className="text-[12px] leading-snug text-ink-2">{t.description}</span>
      {earned
        ? <span className={kickerSm}>{earnedLine(t)}</span>
        : progress && (
          <span className="mt-1 flex items-center gap-2">
            <span className="h-1 flex-1 bg-rule-2"><span className="block h-1 bg-gold" style={{ width: `${pct}%` }} /></span>
            <span className={kickerSm}>{progress}</span>
          </span>
        )}
    </li>
  );
}

/**
 * The wall: fifty tiles (twelve on a clan's), grouped, earned in gold, locked
 * dimmed with progress. `id="achievements"` is what the owner's
 * closest-to-unlocking panel links down to.
 *
 * ⚠️ A tile carries a name, a description, a count and a date — never a
 * coordinate. The wall is public on every profile and clan page.
 */
export function AchievementWall({ wall, title = WALL.title, className }: { wall: Wall; title?: string; className?: string }) {
  const groups = ACHIEVEMENT_GROUPS.filter((g) => wall.tiles.some((t) => t.group === g));
  return (
    <Panel id="achievements" title={title} aside={WALL.earnedOf(wall.earned, wall.tiles.length)} className={className}>
      <PanelBody>
        {groups.map((g) => (
          <section key={g} className="mb-5 last:mb-0">
            <h3 className={`${kickerSm} mb-2`}>{GROUP_LABELS[g]}</h3>
            {/* One column on a phone: the wall must never scroll sideways. */}
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {wall.tiles.filter((t) => t.group === g).map((t) => <Tile key={t.key} t={t} />)}
            </ul>
          </section>
        ))}
      </PanelBody>
    </Panel>
  );
}

/** The owner-only nudge: the three counted achievements nearest their target. */
export function ClosestPanel({ wall, href }: { wall: Wall; href: string }) {
  return (
    <Panel title={WALL.closest}>
      <PanelBody>
        {wall.closest.length === 0
          ? <p className="m-0 text-[13px] text-ink-2">{WALL.none}</p>
          : <ul className="m-0 grid list-none gap-2 p-0">{wall.closest.map((t) => <Tile key={t.key} t={t} />)}</ul>}
        <a className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:underline" href={href}>All achievements <span aria-hidden="true">→</span></a>
      </PanelBody>
    </Panel>
  );
}
