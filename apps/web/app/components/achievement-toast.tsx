import type { AchievementGroup } from "@factions/domain";
import { TOAST, type EarnedTile } from "@/lib/achievements-copy";
import { AchievementBadge } from "@/app/components/achievement-badge";

/** Border and kicker per group — literals, so Tailwind can see them (see TONE in achievement-wall.tsx). */
const TONE: Record<AchievementGroup, { border: string; text: string }> = {
  solo: { border: "border-achievement-solo", text: "text-achievement-solo" },
  pve: { border: "border-achievement-pve", text: "text-achievement-pve" },
  pvp: { border: "border-achievement-pvp", text: "text-achievement-pvp" },
  team: { border: "border-achievement-team", text: "text-achievement-team" },
};

/**
 * "Achievement unlocked" on the owner's own page (design hand-off §03): the
 * unlocked badge, the group kicker in the group's colour, the name, the
 * description. Server-rendered, no client JS — it is a status line, not a
 * popup, and `role="status"` is what makes it read as one.
 *
 * ⚠️ Only for a player-scoped unlock the viewer owns — the caller filters
 * (`freshUnlocks`); this renders whatever it is handed, so hand it nothing else.
 */
export function AchievementToast({ t }: { t: EarnedTile }) {
  const tone = TONE[t.group];
  return (
    <div role="status" className={`flex items-center gap-4 border-2 bg-frame px-4 py-3 ${tone.border}`}>
      <AchievementBadge achievementKey={t.key} group={t.group} state="unlocked" size={56} className="flex-none" />
      <div className="min-w-0">
        <div className={`font-mono text-[11px] uppercase tracking-[0.18em] ${tone.text}`}>{TOAST.kicker(t.group)}</div>
        <div className="mt-1 font-display text-[18px] uppercase leading-tight text-ink">{t.name}</div>
        <div className="mt-0.5 text-[13px] leading-snug text-ink-2">{t.description}</div>
      </div>
    </div>
  );
}
