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

/**
 * The Hub's no-combat zone (spec 2026-09-22-hub-combat §2.1): a CYLINDER, not a
 * circle. The Hub floats — floor 997.5 m, doors 998.6 m, every door within 22 m
 * of HUB_POSITION — and the ground directly beneath it is ordinary map where a
 * fight is legal.
 * ⚠️ The floor is what makes that so. Drop it and every fight on the hill below
 * the Hub is a one-hour ban.
 */
export const HUB_ZONE_RADIUS_M = 100;
export const HUB_ZONE_MIN_ALTITUDE_M = 900;
/** Every hit, kill or trap at the Hub. Measured from when the bot PROCESSES it — log delay must not eat the hour. */
export const HUB_BAN_MS = 1 * HOUR;
/** Self-defence: A may hit B back this long after B hit A. Per pair. */
export const HUB_RETALIATION_WINDOW_MS = 2 * MIN;
/**
 * ⚠️ Not about the sentence. An unseeded or rewound `hub-watch` cursor would
 * otherwise replay the whole log into bans — including the 2026-09-20 brawl,
 * from before the rule existed. Far longer than any log delay seen.
 */
export const HUB_OFFENCE_MAX_AGE_MS = 24 * HOUR;
/**
 * Placing one of these at the Hub is an offence. The first five were read off
 * `item.placed` payloads in factions_live on 2026-09-22.
 * ⚠️ `Plastic_Explosive` has NEVER been placed on this server — vanilla, and
 * included on that basis; confirm its classname the first time it appears.
 * A missing classname here is a trap the rule silently allows.
 */
export const HUB_TRAP_CLASSES = ["BearTrap", "LandMineTrap", "TripwireTrap", "ImprovisedExplosive", "ClaymoreMine", "Plastic_Explosive"] as const;

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
/** Livonia. The one map this deployment runs; `servers.map` says "livonia". */
export const WORLD_SIZE_M = 12800;

/**
 * Vault lock label and note caps, characters.
 *
 * ⚠️ These live here, not in the vault store that enforces them, because
 * `@factions/copy` interpolates them into the player-facing refusal text and
 * `@factions/copy` must stay a leaf over this package. Importing them from
 * `@factions/roster` instead pulls that package's pooled postgres client into
 * whatever imports the copy barrel — and a client component that does so fails
 * `next build` with "Can't resolve 'fs'", which no typecheck or vitest run
 * catches. That is not hypothetical: it broke a deploy on 2026-09-13.
 */
export const VAULT_NAME_MAX = 40;
export const VAULT_NOTE_MAX = 140;

// Getting around
export const TRAVEL_POINTS = 209;
export const HUB_DESTINATIONS = 31;

// Fair play
export const COMBAT_LOG_MS = 10 * MIN;
export const WATCHTOWER_MAX_HEIGHT = { grounded: 2, onStructure: 1 } as const;

/**
 * Scheduled restarts (spec 2026-09-12): the bot restarts the server every
 * RESTART_PERIOD_MS, in slots aligned to the Unix epoch — which is itself an
 * even UTC hour, so there is no phase constant to get wrong. A slot the bot
 * did not fire within RESTART_GRACE_MS of its start is missed, not late: a
 * restart twenty minutes late kicks players who had no countdown.
 */
export const RESTART_PERIOD_MS = 2 * HOUR;
export const RESTART_GRACE_MS = 10 * MIN;

/**
 * The weekly vehicle rotation (spec 2026-09-12). One of these is wiped each Monday
 * alongside the daily trucks, in this order.
 *
 * ⚠️ The `event` strings must match `<event name="…">` in the mission's db/events.xml
 * exactly. A name that is absent (or duplicated outside comments) throws at wipe time —
 * `apps/bot/src/restart-tick.ts` accumulates the daily truck wipe and the rotation into
 * one local `xml` and uploads only after both, so the exception discards the
 * already-computed truck flips too. It is not "that week's wipe silently does not
 * happen" — it is every slot, and it takes the daily truck wipe down with it.
 */
export const WEEKLY_WIPE_VEHICLES = [
  { event: "VehicleCivilianSedan", name: "Olga" },
  { event: "VehicleHatchback02", name: "Gunter" },
  { event: "VehicleOffroad02", name: "Hummer" },
  { event: "VehicleOffroadHatchback", name: "Ada" },
  { event: "VehicleSedan02", name: "Sarka" },
] as const;

/**
 * Monday 2026-09-14 UTC — rotation index 0, so the sequence runs in the order above.
 *
 * ⚠️ Moving this constant re-phases the whole rotation, including weeks already
 * announced. It is the anchor, not a start date to keep current.
 */
export const ROTATION_ANCHOR_MS = Date.UTC(2026, 8, 14);

/** The announcement lands this far before the wipe, and is never posted later than
 *  ANNOUNCE_CUTOFF_MS before it — past that, a notice would describe a wipe that has
 *  effectively already arrived, which is worse than silence. */
export const ANNOUNCE_LEAD_MS = 24 * HOUR;
export const ANNOUNCE_CUTOFF_MS = 1 * HOUR;

// Base-zone enforcement (spec 2026-09-15)
/** How long a base's owner has to press charges on a closed incident. */
export const VIOLATION_REPORT_WINDOW_MS = 7 * DAY;
/** Quiet time that closes an open incident. */
export const VIOLATION_INCIDENT_GAP_MS = 30 * MIN;

/**
 * A boost stack: fireplaces or garden plots stacked to climb a wall.
 *
 * ⚠️ BOTH signals must agree, and each rules out a different false positive.
 * RADIUS separates stacking from farming — a garden plot's own footprint is
 * ~2.5 m, so two side-by-side plots cannot be this close unless one is on top
 * of the other. RISE separates stacking from a cluster of ground-level
 * placements — to put the second item on the first you must stand on the
 * first, so the player's own altitude climbs. Tightness alone flags a
 * fireplace dropped and replaced in one spot; rise alone flags two cook-fires
 * on a hillside.
 *
 * These two are the only numbers in this block derived from physical
 * reasoning rather than a policy choice, and are the likeliest to need
 * tuning after live observation.
 */
export const BOOST_STACK_MIN_ITEMS = 2;
export const BOOST_STACK_RADIUS_M = 1.5;
export const BOOST_STACK_MIN_RISE_M = 0.5;
export const BOOST_STACK_WINDOW_MS = 30 * MIN;

/**
 * The sentence. Breach is FLAT, loss is SCALED — they are different crimes.
 * Breaching is binary: one watchtower is the whole act, and five stacked
 * fireplaces are not worse than three. Loss is cumulative: twenty walls is
 * twice ten, and it is the only class that costs the owner materials to undo.
 */
export const BAN_BASE_MS = 24 * HOUR;
export const BAN_BREACH_MS = 48 * HOUR;
export const BAN_GATE_MS = 24 * HOUR;
export const BAN_PER_DISMANTLE_MS = 12 * HOUR;
export const BAN_FIRST_OFFENCE_CAP_MS = 7 * DAY;
export const BAN_REPEAT_MULTIPLIER = 2;
/** The nth upheld report against one dayz_id within a season is permanent. */
export const BAN_PERMANENT_AT_OFFENCE = 3;

/**
 * ⚠️ How far back `banTick`'s apply arm looks for `pending` rows to send to
 * Nitrado. This guards against a historical dry-run backlog firing at
 * Nitrado in a single tick the moment `BAN_DRY_RUN` flips to `false` — every
 * pending row ever written, going back to the feature's first day, would
 * otherwise become a live ban attempt at once. One Life's unbounded detect
 * query did exactly this.
 *
 * ⚠️ This is NOT, and must never become, the bot's process start time. An
 * earlier draft used that and it is wrong in a way that is invisible: a ban
 * written five minutes before a routine restart has `bannedAt < since`, so
 * it is never applied — yet `reportIncidentDb`'s prior-offence query still
 * counts it as a standing prior (it excludes only `lifted`), so the player
 * serves no ban but still climbs the sentencing ladder, and their next
 * report is harsher for a punishment that never happened. `RESTART_PERIOD_MS`
 * is 2 hours, so a process-start-time bound would trigger this on almost
 * every tick. A fixed lookback from `now` is immune to restarts entirely.
 */
export const BAN_APPLY_LOOKBACK_MS = 24 * HOUR;

/**
 * DayZ classnames that can be stacked into a boost.
 *
 * ⚠️ VERIFY AGAINST A REAL ADM LINE before trusting this list. It is inferred
 * from the single `placed …<…>` sample in the flagpole parser's test, not
 * observed. A missing classname is a silently unenforced exploit.
 */
export const BOOST_ITEM_CLASSES = ["Fireplace", "FireplaceIndoor", "GardenPlot"] as const;

/**
 * DayZ tent classnames. ONE tent placed by a non-member inside a watch zone
 * is a build — a breach — with no stack test at all.
 *
 * ⚠️ Not a boost-stack item, and adding these to `BOOST_ITEM_CLASSES` would
 * catch nothing. The raid that prompted this (SNA's base, 2026-09-22 02:13–
 * 02:47 UTC) placed five tents each from the ground, 3–30 m apart at the
 * same altitude, and climbed them one at a time; `boostStackFor` wants
 * placements within 1.5 m AND a rise between them, and saw neither. A tent is
 * tall enough to be the whole boost on its own.
 *
 * The first five are observed in `factions_live`'s `item.placed` events
 * (2026-09-23); the Party Tents are vanilla and not yet seen. The match is
 * exact, so a colour variant missing here is a tent boost nobody sees.
 */
export const TENT_ITEM_CLASSES = [
  "LargeTent", "CarTent", "MediumTent", "MediumTent_Green", "MediumTent_Orange",
  "PartyTent", "PartyTent_Blue", "PartyTent_Brown", "PartyTent_Lunapark",
] as const;

/**
 * How far back the device lookup looks for connections from accounts whose
 * platform we do not know yet.
 *
 * ⚠️ Bounded on purpose. Without a window, an account whose device can never
 * be resolved (its login straddled a restart and the file has since rotated)
 * would make the worker re-download the live RPT every single sweep, forever.
 * Giving up is safe: the player is caught the next time they connect.
 */
export const DEVICE_LOOKUP_LOOKBACK_MS = 30 * 60 * 1000;

/**
 * How long a booster's kit placement sequence stays open.
 *
 * ⚠️ Much shorter than `LINK_TTL_MS`: the player is standing in the spot they
 * want the kit to land on while they perform it, so a day-long window buys
 * nothing and leaves a stale sequence that moves the kit to wherever they
 * happen to be when they next perform it by chance.
 */
export const KIT_PLACEMENT_TTL_MS = 1 * HOUR;

/**
 * How long an event winner has to mark their award's spot before the grant
 * lapses (awards spec §2.5).
 *
 * ⚠️ The award's own clock starts at the first restart that SPAWNS it, not at
 * the grant, so without this a grant nobody places would hold the award open
 * forever.
 */
export const AWARD_PLACE_BY_MS = 7 * DAY;

/** A bounty's online time to serve, unless the admin passes `hours:` (spec 2026-09-23-bounties §2.4). */
export const BOUNTY_DEFAULT_MS = 72 * HOUR;
/** The most an admin can set. `/bounty place hours:` is capped here. */
export const BOUNTY_MAX_MS = 7 * DAY;
/** A bounty on a player who stops playing closes anyway, this long after it was placed. */
export const BOUNTY_DEADLINE_MS = 30 * DAY;
/**
 * ⚠️ Housekeeping, not a guide number. How long past the end of a bounty it stays
 * claimable before it is expired: a kill made just in time can still be sitting in a
 * log file the worker has not ingested (spec §2.8). Shorter, and log lag robs a
 * hunter; there is no downside to longer except a late "expired" post.
 */
export const BOUNTY_EXPIRY_SETTLE_MS = 15 * 60_000;
/** The reason an admin types. It is posted publicly and DM'd. */
export const BOUNTY_REASON_MAX = 200;

/**
 * How far ahead of an award's expiry restart the spawner file must already
 * have dropped it (awards spec §5.3).
 *
 * ⚠️ `expires_at` falls ON a restart slot, and the restart tick fires up to
 * `RESTART_GRACE_MS` after the slot starts. The worker sweeps every minute and
 * an upload can take a while, so leaving the award in until `expires_at` itself
 * would race the restart and hand the winner one extra session a coin flip at
 * a time. Fifteen minutes clears both.
 */
export const AWARD_REMOVAL_LEAD_MS = 15 * MIN;

/**
 * The 16 Livonia locations with a staged locked-container spawner, and the three
 * colours each is staged in (spec §1).
 *
 * ⚠️ A literal list, deliberately, not a directory read: the bot runs nowhere near
 * the mission tree, and a location named here that has no staged file registers a
 * spawner the server silently ignores. Adding a location means staging three files
 * in the `livonia` repo FIRST.
 */
export const AIRDROP_LOCATIONS = [
  "airfield", "bielawa", "brena", "dolnik", "gieraltow", "gliniska", "grabin", "lukow",
  "nadbor", "polana", "sarnowek", "sitnik", "sobotka", "tarnow", "topolin", "zalesie",
] as const;

export const AIRDROP_COLOURS = ["blue", "orange", "yellow"] as const;

/** How many recent locations are excluded from the draw (spec §3.3). */
export const AIRDROP_NO_REPEAT = 5;

/** How long before a restart slot the decision is taken (spec §3.1). */
export const AIRDROP_DECIDE_LEAD_MS = 30 * 60 * 1000;

/** Minimum gap between two drops (spec §3.1). */
export const AIRDROP_MIN_GAP_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the trailing high-water mark looks (spec §3.1, amended 2026-09-21).
 *
 * The window changed job when the percentile became a max. Under a p90 a longer
 * window was simply steadier; under a MAX it is also the lockout length, because a
 * record blocks every later slot until it ages out.
 *
 * ⚠️ In practice, on this server, that matters far less than it sounds. Replayed
 * against the real session history (253 decision instants, 2026-09-01 to 09-22) the
 * window length is nearly inert: 3d and 5d both fire 5 times, 7d/10d/14d fire 4.
 * The peaks recur often enough that a stale record rarely blocks anything. Do not
 * reach for this constant to change how often drops happen — `AIRDROP_MIN_POP` is
 * the lever that actually moves it (floor 5 → 5 drops, 6 → 3, 7 → 2 over the same
 * three weeks), and it is an env var rather than a code change.
 */
export const AIRDROP_HISTORY_MS = 5 * 24 * 60 * 60 * 1000;

// ─── King of the Hill (spec 2026-09-23-king-of-the-hill) ───────────────────
/** A kill scores if its VICTIM was this close to the hill's centre (2-D). */
export const KOTH_ZONE_RADIUS_M = 500;
export const KOTH_REMINDER_LEAD_MS = 30 * 60_000;
/** How long after the closing restart before scoring, for log lag. */
export const KOTH_SCORE_SETTLE_MS = 10 * 60_000;
/** ⚠️ Reserved: the restore arm treats any preset starting with this as KotH's. */
export const KOTH_PRESET_PREFIX = "koth-";
export const KOTH_AWARD_KEY = "plate-carrier";
/**
 * The events.xml infected events a KotH session switches on.
 * ⚠️ The livonia generator's ZOMBIE_ZONE_NAMES must be a subset — a zone with no
 * active event spawns nothing (koth-drift.test.ts).
 */
export const KOTH_INFECTED_EVENTS: readonly string[] = ["InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic"];
/** The whole-file targets, by directory ("root" = the mission root, "env" = its env/). */
export const KOTH_WHOLE_FILES: readonly { dir: "root" | "env"; name: string }[] = [
  { dir: "root", name: "cfgplayerspawnpoints.xml" },
  { dir: "env", name: "wolf_territories.xml" },
  { dir: "env", name: "bear_territories.xml" },
  { dir: "env", name: "zombie_territories.xml" },
];
