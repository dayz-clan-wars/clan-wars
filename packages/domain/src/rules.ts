/**
 * Every timer, cap, radius and cooldown the player's guide promises, in one
 * place. The guide renders every number FROM this file, through
 * `guide-numbers.ts` (the appendix table and the chapters' `{{KEY|format}}`
 * tokens), so the guide and the code cannot disagree.
 *
 * ⚠️ No other module may state one of these numbers as a literal. A number
 * stated twice will drift, and the symptom is a clock that fires a day early
 * with nothing in any log to say why.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Getting in
export const LINK_EMOTES = 3;
export const LINK_TTL_MS = 24 * HOUR;

// Founding
export const FLAG_POOL_SIZE = 33;
export const CEREMONY_MIN_PARTICIPANTS = 3;
export const CEREMONY_WINDOW_MS = 10 * MIN;
export const CLAIM_WINDOW_MS = 24 * HOUR;
export const ACTIVATION_WINDOW_MS = 24 * HOUR;
export const CLAN_NAME_LENGTH = { min: 3, max: 32 } as const;
export const CLAN_TAG_LENGTH = { min: 2, max: 5 } as const;

// Bases
export const DECLARATIONS_PER_PLAYER = 1;
export const NEW_POLE_GRACE_MS = 7 * DAY;
export const RELEASED_POLE_GRACE_MS = 3 * DAY;
export const MIN_BASE_SPACING_M = 200;
export const WATCH_ZONE_RADIUS_M = 100;
export const SOLO_LAPSE_MS = 7 * DAY;
/**
 * The Fast Travel Hub's arrival point (fast-travel-points.json, `hub`). The
 * 200 m rule treats it as a declaration that always exists and is never
 * published, so no base can sit inside the one place every traveller lands.
 */
export const HUB_POSITION = { x: 100, z: 93 } as const;

// Raiding
export const RAID_DEDUP_MS = 24 * HOUR;
/** Fri 00:00 → Mon 00:00 UTC. Enforced by the game server's config, not here. */
export const RAID_WINDOW = { openDow: 5, closeDow: 1 } as const;

// Defending
export const FLAG_DOWN_MS = 24 * HOUR;
export const DORMANT_AFTER_MS = 7 * DAY;
export const DISBAND_AFTER_DORMANT_MS = 14 * DAY;
/** The guide's "4 days until this clan is disbanded" warning, measured back from DISBAND_AFTER_DORMANT_MS. */
export const DISBAND_WARNING_LEAD_MS = 4 * DAY;

// The scoreboard
export const POINTS_TOP = 200;
export const POINTS_BOTTOM = 100;
export const POINTS_UNRANKED = 100;
export const ALPHAS_PER_WEEK = 3;
export const POST_WIPE_BIND_MS = 7 * DAY;
export const KD_MIN_KILLS = 10;

// Running a clan
export const CLAN_SIZE_CAP = 10;
export const JOIN_PRESENCE_RADIUS_M = 50;
export const PENDING_EXPIRY_MS = 7 * DAY;
export const ROSTER_COOLDOWN_MS = 3 * DAY;
export const LEADER_SILENT_MS = 7 * DAY;
export const SUCCESSION_WINDOW_MS = 48 * HOUR;
export const VOTE_LENGTH_MS = 48 * HOUR;
export const VOTE_THRESHOLD = { num: 2, den: 3 } as const;
export const FAILED_VOTE_COOLDOWN_MS = 14 * DAY;
export const RENAME_COOLDOWN_MS = 30 * DAY;
export const REBIND_CONFIRM_MS = 24 * HOUR;
export const REBIND_COOLDOWN_MS = 7 * DAY;
export const VAULT_CODE_DIGITS = 4;

// Discord
export const GUEST_PASS_MS = 24 * HOUR;

// The map
export const POSITION_FIX_MS = 5 * MIN;
export const INTRUDER_ALERT_COOLDOWN_MS = 20 * MIN;
export const INTRUDER_PIN_TTL_MS = 60 * MIN;
export const PIN_TTL_MS = 7 * DAY;
/**
 * How long `player_positions` rows are kept (spec §4.9). Operational, not a
 * promise the guide makes, so it is deliberately absent from
 * guide-numbers.ts — the guide states only promised numbers.
 */
export const POSITION_RETENTION_MS = 30 * DAY;
export const PIN_ICONS = ["loot", "vehicle", "enemy", "meet", "danger", "note"] as const;
export type PinIcon = (typeof PIN_ICONS)[number];
/** Pin note length cap, characters. UI + package share it. */
export const PIN_NOTE_MAX = 140;

// Getting around
export const TRAVEL_POINTS = 209;
export const HUB_DESTINATIONS = 31;

// Fair play
export const COMBAT_LOG_MS = 10 * MIN;
export const WATCHTOWER_MAX_HEIGHT = { grounded: 2, onStructure: 1 } as const;
