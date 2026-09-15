/**
 * The faction lifecycle transitions the public feed carries.
 *
 * ⚠️ Mirrored by the `faction_events_kind_valid` check constraint in SQL.
 * They are two statements of one fact and
 * `packages/db/test/faction-events-schema.test.ts` is what holds them
 * together — drift means a writer's insert is rejected inside the
 * transition's own transaction, rolling the transition back with it.
 */
export const FACTION_EVENT_KINDS = [
  "founded", "activated", "lapsed", "renamed", "rebound", "dormant", "revived", "disbanded",
] as const;

export type FactionEventKind = (typeof FACTION_EVENT_KINDS)[number];

/** #war-log (spec §4.7, §9.2). week_closed and season_closed are written by increment 4. */
export const WAR_LOG_KINDS = ["raid", "defense", "week_closed", "season_closed"] as const;
export type WarLogKind = (typeof WAR_LOG_KINDS)[number];

/**
 * clan_notices kinds that exist as of increment 7 (spec §9.3, §9.4).
 * apps/bot/test/notice-text.test.ts pins that every kind here has a
 * renderer and no renderer exists for a kind not here.
 */
export const CLAN_NOTICE_KINDS = [
  "flag_down", "defended", "dormant_raided", "dormant_inactive", "revived", "disband_warning",
  "non_member_raise", "colors_elsewhere", "rebind_proposed", "rebind_confirmed",
  "joined", "became_full", "left", "kicked", "promoted", "demoted", "transferred", "renamed",
  "invited", "request_accepted", "request_declined", "pending_expired", "solo_non_member_raise", "solo_lapsed",
  "intruder", "dismantle", "gate_built", "solo_intruder", "solo_dismantle", "solo_gate",
  "leader_removed", "succession_claimed", "succession_voided", "succession_done",
  "vote_opened", "vote_passed", "vote_failed", "codes_rotated", "guest", "achievement",
] as const;
export type ClanNoticeKind = (typeof CLAN_NOTICE_KINDS)[number];
export const NOTICE_TARGETS = ["channel", "dm"] as const;
export type NoticeTarget = (typeof NOTICE_TARGETS)[number];

export const DORMANT_REASONS = ["raided", "inactive"] as const;
export type DormantReason = (typeof DORMANT_REASONS)[number];
