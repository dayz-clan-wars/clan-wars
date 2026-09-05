import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as R from "../src/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(readFileSync(resolve(here, "..", "..", "..", "docs", "guide-numbers.json"), "utf8")) as {
  rows: { label: string; value: string }[];
};

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const days = (ms: number) => `${ms / DAY} days`;
const hours = (ms: number) => `${ms / HOUR} h`;
const mins = (ms: number) => `${ms / MIN} min`;

/**
 * ⚠️ Two statements of one fact: the guide's table and rules.ts. This map is
 * the seam. Every row in the JSON must appear here, and every rendering must
 * equal the guide's text exactly — a rule that drifts by a day renders as
 * "8 days" and fails.
 */
const EXPECTED: Record<string, string> = {
  "Link: emotes to perform": `${R.LINK_EMOTES}, in order`,
  "Link: time limit": mins(R.LINK_TTL_MS),
  "Flags in the pool": `${R.FLAG_POOL_SIZE} (white is neutral)`,
  "Ceremony: linked players required": `${R.CEREMONY_MIN_PARTICIPANTS}`,
  "Ceremony: window": mins(R.CEREMONY_WINDOW_MS),
  "Claim window after ceremony": hours(R.CLAIM_WINDOW_MS),
  "Activation window after claim": hours(R.ACTIVATION_WINDOW_MS),
  "Clan name length": `${R.CLAN_NAME_LENGTH.min}–${R.CLAN_NAME_LENGTH.max}`,
  "Clan tag length": `${R.CLAN_TAG_LENGTH.min}–${R.CLAN_TAG_LENGTH.max}`,
  "Declarations per player": `${R.DECLARATIONS_PER_PLAYER}`,
  "New pole grace before public": days(R.NEW_POLE_GRACE_MS),
  "Released pole grace before public": days(R.RELEASED_POLE_GRACE_MS),
  "Minimum distance between declared bases": `${R.MIN_BASE_SPACING_M} m`,
  "Watch zone radius": `${R.WATCH_ZONE_RADIUS_M} m`,
  "Solo declaration lapses after (no raise by declarant)": days(R.SOLO_LAPSE_MS),
  "Raid credit dedup (raider clan → victim)": hours(R.RAID_DEDUP_MS),
  "Raid window (base damage on)": "Fri 00:00 → Mon 00:00 UTC",
  "Flag-down clock": hours(R.FLAG_DOWN_MS),
  "Inactivity → dormant": days(R.DORMANT_AFTER_MS),
  "Dormant → disbanded": days(R.DISBAND_AFTER_DORMANT_MS),
  "Points: raid on #1 / bottom / unranked": `${R.POINTS_TOP} / ${R.POINTS_BOTTOM} / ${R.POINTS_UNRANKED}`,
  "Alpha week": "Mon 00:00 → Mon 00:00 UTC",
  "Alphas per week": `${R.ALPHAS_PER_WEEK}`,
  "Season": "wipe to wipe",
  "After a wipe: raise your flag to bind a new base within": days(R.POST_WIPE_BIND_MS),
  "Player board: minimum kills for K/D": `${R.KD_MIN_KILLS}`,
  "Clan size cap": `${R.CLAN_SIZE_CAP}`,
  "Join: presence radius at base": `${R.JOIN_PRESENCE_RADIUS_M} m`,
  "Invite / request / pending no-show expiry": days(R.PENDING_EXPIRY_MS),
  "Leave / kick cooldown": days(R.ROSTER_COOLDOWN_MS),
  "Leader silent before a succession claim": days(R.LEADER_SILENT_MS),
  "Succession: objection window": hours(R.SUCCESSION_WINDOW_MS),
  "No-confidence vote: length": hours(R.VOTE_LENGTH_MS),
  "No-confidence vote: threshold": "⅔ of all full members",
  "Failed vote cooldown": days(R.FAILED_VOTE_COOLDOWN_MS),
  "Rename cooldown": days(R.RENAME_COOLDOWN_MS),
  "Old name / tag held after rename or disband": "until season end",
  "Rebind: confirm window": hours(R.REBIND_CONFIRM_MS),
  "Rebind: cooldown between moves": days(R.REBIND_COOLDOWN_MS),
  "Vault code length": `${R.VAULT_CODE_DIGITS} digits`,
  "Guest pass": `${hours(R.GUEST_PASS_MS)}, voice only`,
  "Position fix cadence": `${mins(R.POSITION_FIX_MS)} (set by the server)`,
  "Intruder: alert cooldown per player": mins(R.INTRUDER_ALERT_COOLDOWN_MS),
  "Intruder: pin drops off after": mins(R.INTRUDER_PIN_TTL_MS),
  "Pin lifetime": days(R.PIN_TTL_MS),
  "Fast travel points (outhouses, wells, bus stops)": `${R.TRAVEL_POINTS}`,
  "Hub destinations": `${R.HUB_DESTINATIONS} towns`,
  "Combat log rule": `${mins(R.COMBAT_LOG_MS)} after contact`,
  "Watchtower height": `${R.WATCHTOWER_MAX_HEIGHT.grounded} (${R.WATCHTOWER_MAX_HEIGHT.onStructure} on a structure)`,
};

describe("rules.ts matches the guide's numbers table", () => {
  it("covers every row in the vendored table", () => {
    const labels = json.rows.map((r) => r.label);
    expect(Object.keys(EXPECTED).sort()).toEqual([...labels].sort());
  });

  for (const row of json.rows) {
    it(`"${row.label}" is ${row.value}`, () => {
      expect(EXPECTED[row.label]).toBe(row.value);
    });
  }

  it("⚠️ the vote threshold text is the fraction rules.ts states", () => {
    expect(`${R.VOTE_THRESHOLD.num}/${R.VOTE_THRESHOLD.den}`).toBe("2/3");
  });
});
