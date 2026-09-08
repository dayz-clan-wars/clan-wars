import * as R from "./rules.js";

/**
 * Every number the player's guide promises, stated ONCE, computed from
 * rules.ts. Two consumers: the guide's "Every number" appendix renders
 * GUIDE_NUMBERS as its table, and the chapters' prose carries tokens like
 * `{{FLAG_DOWN_MS|hours}}` that apps/web/app/guide/render.ts resolves through
 * guideNumber(). Until 2026-09-07 the appendix was hand-typed HTML and a drift
 * test held it to rules.ts through a vendored JSON; now there is nothing to
 * drift, and packages/domain/test/guide-numbers.test.ts pins the rows.
 *
 * ⚠️ Adding a public number: add it to rules.ts, then a row here (group,
 * label, key). The key names the rules.ts export; the unit comes from the
 * key's suffix (_MS, _M) or is a count. A row's `value` is its appendix text.
 */
export type Format = "days" | "hours" | "minutes" | "h" | "min" | "m" | "n";
export type GuideNumber = { key: string; group: string; label: string; value: string };

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** The rules.ts exports the guide may name, by key. Composite rows (ranges, pairs) format themselves below. */
const SCALARS: Record<string, number> = {
  LINK_EMOTES: R.LINK_EMOTES, LINK_TTL_MS: R.LINK_TTL_MS,
  FLAG_POOL_SIZE: R.FLAG_POOL_SIZE, CEREMONY_MIN_PARTICIPANTS: R.CEREMONY_MIN_PARTICIPANTS, CEREMONY_WINDOW_MS: R.CEREMONY_WINDOW_MS,
  CLAIM_WINDOW_MS: R.CLAIM_WINDOW_MS, ACTIVATION_WINDOW_MS: R.ACTIVATION_WINDOW_MS,
  DECLARATIONS_PER_PLAYER: R.DECLARATIONS_PER_PLAYER, NEW_POLE_GRACE_MS: R.NEW_POLE_GRACE_MS, RELEASED_POLE_GRACE_MS: R.RELEASED_POLE_GRACE_MS,
  MIN_BASE_SPACING_M: R.MIN_BASE_SPACING_M, WATCH_ZONE_RADIUS_M: R.WATCH_ZONE_RADIUS_M, SOLO_LAPSE_MS: R.SOLO_LAPSE_MS,
  RAID_DEDUP_MS: R.RAID_DEDUP_MS,
  FLAG_DOWN_MS: R.FLAG_DOWN_MS, DORMANT_AFTER_MS: R.DORMANT_AFTER_MS, DISBAND_AFTER_DORMANT_MS: R.DISBAND_AFTER_DORMANT_MS, DISBAND_WARNING_LEAD_MS: R.DISBAND_WARNING_LEAD_MS,
  POINTS_TOP: R.POINTS_TOP, POINTS_BOTTOM: R.POINTS_BOTTOM, POINTS_UNRANKED: R.POINTS_UNRANKED, ALPHAS_PER_WEEK: R.ALPHAS_PER_WEEK,
  POST_WIPE_BIND_MS: R.POST_WIPE_BIND_MS, KD_MIN_KILLS: R.KD_MIN_KILLS,
  CLAN_SIZE_CAP: R.CLAN_SIZE_CAP, JOIN_PRESENCE_RADIUS_M: R.JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS: R.PENDING_EXPIRY_MS, ROSTER_COOLDOWN_MS: R.ROSTER_COOLDOWN_MS,
  LEADER_SILENT_MS: R.LEADER_SILENT_MS, SUCCESSION_WINDOW_MS: R.SUCCESSION_WINDOW_MS, VOTE_LENGTH_MS: R.VOTE_LENGTH_MS, FAILED_VOTE_COOLDOWN_MS: R.FAILED_VOTE_COOLDOWN_MS,
  RENAME_COOLDOWN_MS: R.RENAME_COOLDOWN_MS, REBIND_CONFIRM_MS: R.REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS: R.REBIND_COOLDOWN_MS, VAULT_CODE_DIGITS: R.VAULT_CODE_DIGITS,
  GUEST_PASS_MS: R.GUEST_PASS_MS,
  POSITION_FIX_MS: R.POSITION_FIX_MS, INTRUDER_ALERT_COOLDOWN_MS: R.INTRUDER_ALERT_COOLDOWN_MS, INTRUDER_PIN_TTL_MS: R.INTRUDER_PIN_TTL_MS, PIN_TTL_MS: R.PIN_TTL_MS,
  TRAVEL_POINTS: R.TRAVEL_POINTS, HUB_DESTINATIONS: R.HUB_DESTINATIONS,
  COMBAT_LOG_MS: R.COMBAT_LOG_MS,
};

type Unit = "ms" | "m" | "count";
const unitOf = (key: string): Unit => key.endsWith("_MS") ? "ms" : key.endsWith("_M") ? "m" : "count";

/**
 * The guide's spelling for a duration: days from three days up, hours below
 * that (the guide says "48 h" and "24 h", never "2 days" or "1 day"), minutes
 * when hours do not divide.
 */
function durationParts(ms: number): { n: number; unit: "day" | "hour" | "minute" } {
  if (ms % DAY === 0 && ms / DAY >= 3) return { n: ms / DAY, unit: "day" };
  if (ms % HOUR === 0) return { n: ms / HOUR, unit: "hour" };
  return { n: ms / MIN, unit: "minute" };
}

/** A duration in the unit the token asks for, refusing a unit the value does not divide into. */
function duration(key: string, ms: number, f: Format): string {
  const per = f === "days" ? DAY : f === "hours" || f === "h" ? HOUR : MIN;
  if (ms % per !== 0) throw new Error(`guide number ${key} is not a whole number of ${f}`);
  const n = ms / per;
  switch (f) {
    case "days": return `${n} day${n === 1 ? "" : "s"}`;
    case "hours": return `${n} hour${n === 1 ? "" : "s"}`;
    case "minutes": return `${n} minute${n === 1 ? "" : "s"}`;
    case "h": return `${n} h`;
    case "min": return `${n} min`;
    default: throw new Error(`unreachable format ${f}`);
  }
}

/** The appendix's short form: "24 h", "7 days", "10 min", "100 m", "10". */
function appendixValue(key: string): string {
  const v = SCALARS[key]!;
  const unit = unitOf(key);
  if (unit === "m") return `${v} m`;
  if (unit === "count") return `${v}`;
  const { n, unit: u } = durationParts(v);
  return u === "day" ? `${n} days` : u === "hour" ? `${n} h` : `${n} min`;
}

/**
 * The text for a `{{KEY}}` or `{{KEY|format}}` token. Without a format, the
 * appendix's short form. ⚠️ Throws on an unknown key or a format that does
 * not fit the key's unit — the renderer surfaces that at build time, which is
 * the point: a typo in a token must never ship as literal braces.
 */
export function guideNumber(key: string, format?: Format): string {
  const composite = COMPOSITE[key];
  if (composite !== undefined) {
    if (format !== undefined && format !== "n") throw new Error(`guide number ${key} takes no format`);
    return composite;
  }
  const v = SCALARS[key];
  if (v === undefined) throw new Error(`unknown guide number ${key}`);
  const unit = unitOf(key);
  if (format === undefined) return appendixValue(key);
  if (format === "n") return `${unit === "ms" ? durationParts(v).n : v}`;
  if (unit === "ms") {
    if (format === "m") throw new Error(`guide number ${key} is a duration, not metres`);
    return duration(key, v, format);
  }
  if (unit === "m") {
    if (format !== "m") throw new Error(`guide number ${key} is metres, not a duration`);
    return `${v} m`;
  }
  throw new Error(`guide number ${key} is a count and takes only "n"`);
}

/** Rows whose appendix text is not a bare scalar. Keyed so prose can name them too. */
const COMPOSITE: Record<string, string> = {
  LINK_EMOTES_ORDERED: `${R.LINK_EMOTES}, in order`,
  FLAG_POOL: `${R.FLAG_POOL_SIZE} (white is neutral)`,
  CLAN_NAME_LENGTH: `${R.CLAN_NAME_LENGTH.min}–${R.CLAN_NAME_LENGTH.max}`,
  CLAN_TAG_LENGTH: `${R.CLAN_TAG_LENGTH.min}–${R.CLAN_TAG_LENGTH.max}`,
  RAID_WINDOW: "Fri 00:00 → Mon 00:00 UTC",
  POINTS: `${R.POINTS_TOP} / ${R.POINTS_BOTTOM} / ${R.POINTS_UNRANKED}`,
  ALPHA_WEEK: "Mon 00:00 → Mon 00:00 UTC",
  SEASON: "wipe to wipe",
  VOTE_THRESHOLD: `${R.VOTE_THRESHOLD.num === 2 && R.VOTE_THRESHOLD.den === 3 ? "⅔" : `${R.VOTE_THRESHOLD.num}/${R.VOTE_THRESHOLD.den}`} of all full members`,
  NAME_HOLD: "until season end",
  VAULT_CODE: `${R.VAULT_CODE_DIGITS} digits`,
  GUEST_PASS: `${appendixValueOf(R.GUEST_PASS_MS)}, voice only`,
  POSITION_FIX: `${appendixValueOf(R.POSITION_FIX_MS)} (set by the server)`,
  HUB_DESTINATIONS_TOWNS: `${R.HUB_DESTINATIONS} towns`,
  COMBAT_LOG: `${appendixValueOf(R.COMBAT_LOG_MS)} after contact`,
  WATCHTOWER: `${R.WATCHTOWER_MAX_HEIGHT.grounded} (${R.WATCHTOWER_MAX_HEIGHT.onStructure} on a structure)`,
};

function appendixValueOf(ms: number): string {
  const { n, unit } = durationParts(ms);
  return unit === "day" ? `${n} days` : unit === "hour" ? `${n} h` : `${n} min`;
}

export const GUIDE_GROUPS = ["Getting in", "Founding", "Bases", "Raiding", "Defending", "The scoreboard", "Running a clan", "Discord", "The map", "Getting around", "Fair play"] as const;

const row = (group: (typeof GUIDE_GROUPS)[number], label: string, key: string): GuideNumber => ({ key, group, label, value: guideNumber(key) });

/** The appendix, in the guide's order. */
export const GUIDE_NUMBERS: readonly GuideNumber[] = [
  row("Getting in", "Link: emotes to perform", "LINK_EMOTES_ORDERED"),
  row("Getting in", "Link: time limit", "LINK_TTL_MS"),
  row("Founding", "Flags in the pool", "FLAG_POOL"),
  row("Founding", "Ceremony: linked players required", "CEREMONY_MIN_PARTICIPANTS"),
  row("Founding", "Ceremony: window", "CEREMONY_WINDOW_MS"),
  row("Founding", "Claim window after ceremony", "CLAIM_WINDOW_MS"),
  row("Founding", "Activation window after claim", "ACTIVATION_WINDOW_MS"),
  row("Founding", "Clan name length", "CLAN_NAME_LENGTH"),
  row("Founding", "Clan tag length", "CLAN_TAG_LENGTH"),
  row("Bases", "Declarations per player", "DECLARATIONS_PER_PLAYER"),
  row("Bases", "New pole grace before public", "NEW_POLE_GRACE_MS"),
  row("Bases", "Released pole grace before public", "RELEASED_POLE_GRACE_MS"),
  row("Bases", "Minimum distance between declared bases", "MIN_BASE_SPACING_M"),
  row("Bases", "Watch zone radius", "WATCH_ZONE_RADIUS_M"),
  row("Bases", "Solo declaration lapses after (no raise by declarant)", "SOLO_LAPSE_MS"),
  row("Raiding", "Same clan raiding the same victim counts once per", "RAID_DEDUP_MS"),
  row("Raiding", "Raid window (base damage on)", "RAID_WINDOW"),
  row("Defending", "Flag-down clock", "FLAG_DOWN_MS"),
  row("Defending", "Inactivity → dormant", "DORMANT_AFTER_MS"),
  row("Defending", "Dormant → disbanded", "DISBAND_AFTER_DORMANT_MS"),
  row("The scoreboard", "Points: raid on #1 / bottom / unranked", "POINTS"),
  row("The scoreboard", "Alpha week", "ALPHA_WEEK"),
  row("The scoreboard", "Alphas per week", "ALPHAS_PER_WEEK"),
  row("The scoreboard", "Season", "SEASON"),
  row("The scoreboard", "After a wipe: raise your flag to bind a new base within", "POST_WIPE_BIND_MS"),
  row("The scoreboard", "Player board: minimum kills for K/D", "KD_MIN_KILLS"),
  row("Running a clan", "Clan size cap", "CLAN_SIZE_CAP"),
  row("Running a clan", "Join: presence radius at base", "JOIN_PRESENCE_RADIUS_M"),
  row("Running a clan", "Invite / request / pending no-show expiry", "PENDING_EXPIRY_MS"),
  row("Running a clan", "Leave / kick cooldown", "ROSTER_COOLDOWN_MS"),
  row("Running a clan", "Leader silent before a succession claim", "LEADER_SILENT_MS"),
  row("Running a clan", "Succession: objection window", "SUCCESSION_WINDOW_MS"),
  row("Running a clan", "No-confidence vote: length", "VOTE_LENGTH_MS"),
  row("Running a clan", "No-confidence vote: threshold", "VOTE_THRESHOLD"),
  row("Running a clan", "Failed vote cooldown", "FAILED_VOTE_COOLDOWN_MS"),
  row("Running a clan", "Rename cooldown", "RENAME_COOLDOWN_MS"),
  row("Running a clan", "Old name / tag held after rename or disband", "NAME_HOLD"),
  row("Running a clan", "Base move: confirm window", "REBIND_CONFIRM_MS"),
  row("Running a clan", "Base move: cooldown between moves", "REBIND_COOLDOWN_MS"),
  row("Running a clan", "Vault code length", "VAULT_CODE"),
  row("Discord", "Guest pass", "GUEST_PASS"),
  row("The map", "Position fix cadence", "POSITION_FIX"),
  row("The map", "Intruder: alert cooldown per player", "INTRUDER_ALERT_COOLDOWN_MS"),
  row("The map", "Intruder: pin drops off after", "INTRUDER_PIN_TTL_MS"),
  row("The map", "Pin lifetime", "PIN_TTL_MS"),
  row("Getting around", "Fast travel points (outhouses, wells, bus stops)", "TRAVEL_POINTS"),
  row("Getting around", "Hub destinations", "HUB_DESTINATIONS_TOWNS"),
  row("Fair play", "Combat log rule", "COMBAT_LOG"),
  row("Fair play", "Watchtower height", "WATCHTOWER"),
];

/** Every key a prose token may name. */
export const GUIDE_NUMBER_KEYS: readonly string[] = [...Object.keys(SCALARS), ...Object.keys(COMPOSITE)];
