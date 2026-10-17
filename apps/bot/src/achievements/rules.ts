import type { EarnableKey } from "@factions/domain";
import type { Rule } from "./types.js";
import { SOLO_RULES } from "./rules-solo.js";
import { PVE_RULES } from "./rules-pve.js";
import { PVP_RULES } from "./rules-pvp.js";
import { TEAM_RULES } from "./rules-team.js";

// Each *_RULES map is typed Partial<Record<EarnableKey, Rule>> (a group only ever fills its
// own slice), so TS can never prove — from the four *declared* types alone — that the spread
// covers every key, even once it actually does. The `as` below is the totality claim; what backs
// it is `rules.test.ts`'s two-way diff against EARNABLE_ACHIEVEMENTS, which fails loudly if a key is
// ever missing or duplicated. One rule per earnable key; a retired key (Wanderer) has none, so
// nothing can unlock it again, while its existing unlock rows stay untouched.
export const RULES = { ...SOLO_RULES, ...PVE_RULES, ...PVP_RULES, ...TEAM_RULES } as Record<EarnableKey, Rule>;
