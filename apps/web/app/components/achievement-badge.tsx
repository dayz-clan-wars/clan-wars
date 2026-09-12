import type { AchievementGroup, AchievementKey } from "@factions/domain";
import { GROUP_COLORS } from "@/lib/achievements-copy";
import { ACHIEVEMENT_GLYPHS } from "@/lib/achievement-glyphs";

/** The shield every badge is drawn on (design hand-off 2026-09-12, 64×64 space). */
export const SHIELD = "M32 4l22 8v16c0 14-10 24-22 32C20 52 10 42 10 28V12z";
const LOCKED_FILL = "#0b0b0a";
const LOCKED_STROKE = "#2a2825";
const LOCKED_GLYPH = "#4a4640";
const PROGRESS_GLYPH = "#8a857c";

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
  const glyph = unlocked ? colour : state === "progress" ? PROGRESS_GLYPH : LOCKED_GLYPH;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" className={className}>
      <path d={SHIELD} fill={unlocked ? tint(colour) : LOCKED_FILL} stroke={unlocked ? colour : LOCKED_STROKE} strokeWidth="2" strokeLinejoin="miter" />
      {state === "progress" && (
        <path d={SHIELD} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="miter" strokeLinecap="square" pathLength={100} strokeDasharray={`${clampPct(pct)} 100`} />
      )}
      <g transform="translate(17 15) scale(1.25)">
        <path d={ACHIEVEMENT_GLYPHS[achievementKey]} fill="none" stroke={glyph} strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
      </g>
    </svg>
  );
}
