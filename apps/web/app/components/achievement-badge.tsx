import type { AchievementGroup, AchievementKey } from "@factions/domain";
import { GROUP_COLORS } from "@/lib/achievements-copy";
import { ACHIEVEMENT_GLYPHS } from "@/lib/achievement-glyphs";

/** The shield every badge is drawn on (design hand-off 2026-09-12, 64×64 space). */
export const SHIELD = "M32 4l22 8v16c0 14-10 24-22 32C20 52 10 42 10 28V12z";

export type BadgeState = "unlocked" | "locked" | "progress";

/** `#rrggbb` at 12% — the unlocked shield's tint. */
function tint(hex: string): string {
  return `${hex}1f`;
}

/** 0–100, whole: a cached count can outrun its target and nothing stops a future counter going negative — either would draw the ring off the shield. */
export function clampPct(pct: number | undefined): number {
  if (pct === undefined || Number.isNaN(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * One badge, inline. A server component: the glyph paths are read from the
 * SVGs at build time (scripts/build-achievement-glyphs.ts), so the wall costs
 * a page no fetch and no client JS.
 *
 * `progress` draws the shield twice — the second as a ring in the group
 * colour, `pathLength="100"` so the dash is the percentage — which is what
 * replaces the old 1px bar on the tile.
 *
 * `aria-hidden`: the tile carries the accessible name (state included), so
 * the picture must not announce a second, wordless one.
 */
export function AchievementBadge({ achievementKey, group, state, pct, size = 56, className }: {
  /** `key` is React's own prop name, so the achievement's is spelled out. */
  achievementKey: AchievementKey; group: AchievementGroup; state: BadgeState; pct?: number; size?: number; className?: string;
}) {
  const colour = GROUP_COLORS[group];
  const unlocked = state === "unlocked";
  // ⚠️ Unlocked stays hex ATTRIBUTES: app/api/og/achievement/[key] draws this
  // component through next/og, which resolves no CSS, so a class there would
  // paint nothing — and the card only ever draws `unlocked`. Locked and
  // progress are site-only, so they take the palette's tokens as classes
  // instead of hex copies of them (L2): frame / rule-2 for the shield,
  // rule-3 for a locked glyph, muted for one in progress.
  const glyph = unlocked ? { stroke: colour } : { className: state === "progress" ? "stroke-muted" : "stroke-rule-3" };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" className={className}>
      {unlocked
        ? <path d={SHIELD} fill={tint(colour)} stroke={colour} strokeWidth="2" strokeLinejoin="miter" />
        : <path d={SHIELD} className="fill-frame stroke-rule-2" strokeWidth="2" strokeLinejoin="miter" />}
      {state === "progress" && (
        <path d={SHIELD} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="miter" strokeLinecap="square" pathLength={100} strokeDasharray={`${clampPct(pct)} 100`} />
      )}
      <g transform="translate(17 15) scale(1.25)">
        <path d={ACHIEVEMENT_GLYPHS[achievementKey]} fill="none" {...glyph} strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
      </g>
    </svg>
  );
}
