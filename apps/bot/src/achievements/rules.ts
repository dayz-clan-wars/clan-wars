import type { AchievementKey } from "@factions/domain";
import type { Rule } from "./types.js";
import { SOLO_RULES } from "./rules-solo.js";
import { PVE_RULES } from "./rules-pve.js";
import { PVP_RULES } from "./rules-pvp.js";
import { TEAM_RULES } from "./rules-team.js";

/** One rule per key. The test diffs this against ACHIEVEMENT_KEYS in both directions. */
export const RULES: Record<AchievementKey, Rule> = { ...SOLO_RULES, ...PVE_RULES, ...PVP_RULES, ...TEAM_RULES };
