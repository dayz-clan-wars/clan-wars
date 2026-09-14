export { TABLES, type Action, REFUSAL, DISBAND_WARNING } from "./clan";
export { VAULT_TABLES, type VaultAction, VAULT_INTRO, revealedCopy, rotatedCopy } from "./vault";
export { LEADERSHIP_TABLES, type LeadershipAction, CLAIM_REFUSAL } from "./leadership";
export { DECLARE_COPY, RELEASE_COPY, DECLARED_OK, lapsedCopy } from "./base";
export { ISSUE_COPY, ENDED_COPY, UNLINK_COPY, unlinkCopy, formatRemaining } from "./link";
export { PIN_RESULT_COPY, PIN_ICON_LABELS } from "./map";
export { EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE } from "./scoring";
export { BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE, playTime, scopeLabel } from "./stats";
export { days, hours, when } from "./format";
export {
  discordCopy, discordVaultCopy, discordLeadershipCopy,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
} from "./discord";
