/** Site-owned field lengths for the recruiting post. Not guide numbers — the guide sets no limit — so they live here, not in rules.ts. */
export const RECRUITING_LIMITS = { playWindow: 64, language: 32, pitch: 280 } as const;
/** Gamertags and pole keys are bounded by the log's own shapes; these only stop a form from posting a novel. */
export const GAMERTAG_MAX = 64;
export const POLE_KEY_MAX = 64;
