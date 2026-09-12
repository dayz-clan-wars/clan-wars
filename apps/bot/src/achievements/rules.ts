import type { AchievementKey } from "@factions/domain";
import type { Rule } from "./types.js";
import { SOLO_RULES } from "./rules-solo.js";
import { PVE_RULES } from "./rules-pve.js";
import { PVP_RULES } from "./rules-pvp.js";
import { TEAM_RULES } from "./rules-team.js";

// Each *_RULES map is typed Partial<Record<AchievementKey, Rule>> (a group only ever fills its
// own slice), so TS can never prove — from the four *declared* types alone — that the spread
// covers every key, even once it actually does. The `as` below is the totality claim; what backs
// it is `rules.test.ts`'s two-way diff against ACHIEVEMENT_KEYS, which fails loudly if a key is
// ever missing or duplicated. One rule per key. The test diffs this against ACHIEVEMENT_KEYS in both directions.
export const RULES = { ...SOLO_RULES, ...PVE_RULES, ...PVP_RULES, ...TEAM_RULES } as Record<AchievementKey, Rule>;
