import type { AchievementWall as Wall, AchievementTile } from "@factions/roster";
import { ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUPS, ARMORY_KEYS, isArmory, type AchievementGroup } from "@factions/domain";
import { ARMORY_LABEL, armoryCount } from "@factions/copy";
import { GROUP_LABELS, WALL, progressLine, earnedLine } from "@/lib/achievements-copy";
import { Panel, PanelBody, kickerSm } from "@/app/components/ui";
import { AchievementBadge } from "@/app/components/achievement-badge";

/**
 * The three colour classes a tile takes from its group. Spelled out as
 * literals, one per group, because Tailwind reads class names from source:
 * a `border-achievement-${g}` template would compile to nothing.
 */
const TONE: Record<AchievementGroup, { border: string; bg: string; text: string }> = {
  solo: { border: "border-achievement-solo", bg: "bg-achievement-solo/6", text: "text-achievement-solo" },
  pve: { border: "border-achievement-pve", bg: "bg-achievement-pve/6", text: "text-achievement-pve" },
  pvp: { border: "border-achievement-pvp", bg: "bg-achievement-pvp/6", text: "text-achievement-pvp" },
  team: { border: "border-achievement-team", bg: "bg-achievement-team/6", text: "text-achievement-team" },
};

/**
 * One achievement: the badge at left, the words at right. A server component
 * with no client JS — progress is the badge's ring, drawn once, not a script.
 */
/** kickerSm without its colour: the earned line takes the group's, and two `text-*` classes on one element resolve by stylesheet order, not by which was written last. */
const kickerBare = "font-mono text-[11px] uppercase tracking-[0.18em]";

export function Tile({ t }: { t: AchievementTile }) {
  const earned = t.earnedAt !== null;
  const progress = progressLine(t);
  const tone = TONE[t.group];
  // ⚠️ Clamped both ends: a cached count can outrun its target, and nothing
  // stops a future counter going negative — either would draw the ring off the shield.
  const pct = earned ? 100 : Math.max(0, Math.min(100, Math.round((t.count / t.target) * 100)));
  const state = earned ? "unlocked" : progress ? "progress" : "locked";
  return (
    // ⚠️ The state is said in the tile's own visible WORDS (the earned line,
    // the progress count, "Locked") — never only in colour, and not in an
    // aria-label on the <li>, which some screen readers ignore and which only
    // restated this text (L8).
    <li className={`flex items-center gap-3 border-2 px-3 py-2.5 ${earned ? `${tone.border} ${tone.bg}` : "border-rule-2 bg-surface"}`}>
      <AchievementBadge achievementKey={t.key} group={t.group} state={state} pct={pct} size={56} className="flex-none" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`font-display text-[13px] uppercase tracking-[0.06em] ${earned ? tone.text : "text-ink-2"}`}>{t.name}</span>
        <span className="text-[12px] leading-snug text-ink-2">{t.description}</span>
        {earned
          ? <span className={`${kickerBare} ${tone.text}`}>{earnedLine(t)}</span>
          : progress
            ? <span className={kickerSm}>{progress}</span>
            // ⚠️ Said in words, not only in the badge's grey: a one-shot has no
            // ring, so without this line earned and locked would differ by hue alone.
            : <span className={kickerSm}>{WALL.locked}</span>}
      </span>
    </li>
  );
}

/** One column on a phone: the wall must never scroll sideways. */
const GRID = "m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3";

const armory = (t: AchievementTile): boolean => isArmory(ACHIEVEMENT_BY_KEY[t.key]);

/**
 * The wall: every earnable tile (plus any retired one the player holds: Wanderer,
 * Wolf Bait, Bear Necessities; a clan's carries its team tiles only), grouped, earned in the group's colour, in progress with a ring
 * on the badge, locked in grey. `id="achievements"` is what the owner's
 * closest-to-unlocking panel links down to.
 *
 * The 59 armory tiles (one per gun, the six classes, Full Armory) sit inside Combat
 * in a native <details>, shut until opened: shown flat, they would bury the rest of
 * Combat. <details> opens and closes itself, is keyboard- and screen-reader-operable,
 * and keeps this a server component with no client JS. The summary line says the
 * earned count, so a shut section still reports progress.
 *
 * ⚠️ A tile carries a name, a description, a count and a date — never a
 * coordinate. The wall is public on every profile and clan page.
 */
export function AchievementWall({ wall, title = WALL.title, className }: { wall: Wall; title?: string; className?: string }) {
  const groups = ACHIEVEMENT_GROUPS.filter((g) => wall.tiles.some((t) => t.group === g));
  return (
    <Panel id="achievements" title={title} aside={WALL.earnedOf(wall.earned, wall.tiles.length)} className={className}>
      <PanelBody>
        {groups.map((g) => {
          const inGroup = wall.tiles.filter((t) => t.group === g);
          const guns = inGroup.filter(armory);
          return (
            <section key={g} className="mb-5 last:mb-0">
              <h3 className={`${kickerSm} mb-2`}>{GROUP_LABELS[g]}</h3>
              <ul className={GRID}>
                {inGroup.filter((t) => !armory(t)).map((t) => <Tile key={t.key} t={t} />)}
              </ul>
              {guns.length > 0 && (
                <details className="mt-3 border-2 border-rule-2">
                  <summary className={`${kickerSm} cursor-pointer px-3 py-2.5`}>
                    {/* ⚠️ Out of ARMORY_KEYS, the whole section, not the tiles on this wall: the count is "of 59" for everyone. */}
                    {ARMORY_LABEL} · {armoryCount(guns.filter((t) => t.earnedAt).length, ARMORY_KEYS.length)}
                  </summary>
                  <ul className={`${GRID} px-3 pb-3`}>
                    {guns.map((t) => <Tile key={t.key} t={t} />)}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
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
