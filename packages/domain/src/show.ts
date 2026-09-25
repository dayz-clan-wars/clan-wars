/**
 * The weekly show's state machine (spec 2026-09-25-weekly-show §8.2). `stage` names
 * the last stage that FINISHED. `held` and `rejected` are terminal until an operator acts.
 * ⚠️ Mirrored by the `show_episodes_stage_valid` CHECK; `show-schema.test.ts` holds the two together.
 */
export const SHOW_STAGES = [
  "new", "context", "scripted", "voiced", "rendered", "uploaded",
  "awaiting_approval", "approved", "public", "posted", "done", "held", "rejected",
] as const;
export type ShowStage = (typeof SHOW_STAGES)[number];
