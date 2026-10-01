export { TABLES, type Action, REFUSAL, DISBAND_WARNING } from "./clan";
export { VAULT_TABLES, type VaultAction, VAULT_INTRO, revealedCopy, rotatedCopy } from "./vault";
export { LEADERSHIP_TABLES, type LeadershipAction, CLAIM_REFUSAL } from "./leadership";
export { DECLARE_COPY, RELEASE_COPY, DECLARED_OK, lapsedCopy } from "./base";
export { ISSUE_COPY, ENDED_COPY, UNLINK_COPY, unlinkCopy, formatRemaining, REFERRAL_COPY, REFERRAL_RECORDED, REFERRER_UNNAMED } from "./link";
export { PIN_RESULT_COPY, PIN_ICON_LABELS } from "./map";
export { EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE } from "./scoring";
export { BOARD_LABELS, EMPTY_BOARD, ACHIEVEMENT_CLOSEST, ACHIEVEMENT_NONE, NO_PROFILE, playTime, scopeLabel, boardValue, BOARD_TOP, BOARD_SLUGS, boardKindFromSlug, REFERRERS_WEEK_NOTE, boardHeading } from "./stats";
export { days, hours, when } from "./format";
export { at, rel, atRel } from "./discord-time";
export {
  discordCopy, discordVaultCopy, discordLeadershipCopy,
  DISCORD_OVERRIDES, DISCORD_VAULT_OVERRIDES, DISCORD_LEADERSHIP_OVERRIDES,
} from "./discord";
export {
  type Seg, type Line, type LiveCard, DETAIL_LINE_CAP, playerPath, clanPath,
  who, howLine, detailLine, cappedLines, killCard, hitCard, streakCard, longRangeCard,
  type ClanFeedPayload, clanFeedCard, flagLabel, warLogLine, banLine, achievementLine, onlineLine,
  ONLINE_TITLE, ONLINE_EMPTY, flagDownDuration,
} from "./live-feed";
