import { describe, it, expect } from "vitest";
import * as R from "../src/rules.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

describe("rules", () => {
  it("states the guide's timers in milliseconds", () => {
    expect(R.LINK_TTL_MS).toBe(24 * HOUR);
    expect(R.CEREMONY_WINDOW_MS).toBe(10 * MIN);
    expect(R.CLAIM_WINDOW_MS).toBe(24 * HOUR);
    expect(R.ACTIVATION_WINDOW_MS).toBe(24 * HOUR);
    expect(R.NEW_POLE_GRACE_MS).toBe(7 * DAY);
    expect(R.RELEASED_POLE_GRACE_MS).toBe(3 * DAY);
    expect(R.SOLO_LAPSE_MS).toBe(7 * DAY);
    expect(R.RAID_DEDUP_MS).toBe(24 * HOUR);
    expect(R.FLAG_DOWN_MS).toBe(24 * HOUR);
    expect(R.DORMANT_AFTER_MS).toBe(7 * DAY);
    expect(R.DISBAND_AFTER_DORMANT_MS).toBe(14 * DAY);
    expect(R.POST_WIPE_BIND_MS).toBe(7 * DAY);
    expect(R.PENDING_EXPIRY_MS).toBe(7 * DAY);
    expect(R.ROSTER_COOLDOWN_MS).toBe(3 * DAY);
    expect(R.LEADER_SILENT_MS).toBe(7 * DAY);
    expect(R.SUCCESSION_WINDOW_MS).toBe(48 * HOUR);
    expect(R.VOTE_LENGTH_MS).toBe(48 * HOUR);
    expect(R.FAILED_VOTE_COOLDOWN_MS).toBe(14 * DAY);
    expect(R.RENAME_COOLDOWN_MS).toBe(30 * DAY);
    expect(R.REBIND_CONFIRM_MS).toBe(24 * HOUR);
    expect(R.REBIND_COOLDOWN_MS).toBe(7 * DAY);
    expect(R.GUEST_PASS_MS).toBe(24 * HOUR);
    expect(R.POSITION_FIX_MS).toBe(5 * MIN);
    expect(R.INTRUDER_ALERT_COOLDOWN_MS).toBe(20 * MIN);
    expect(R.INTRUDER_PIN_TTL_MS).toBe(60 * MIN);
    expect(R.PIN_TTL_MS).toBe(7 * DAY);
    expect(R.COMBAT_LOG_MS).toBe(10 * MIN);
  });

  it("states the guide's counts and distances", () => {
    expect(R.LINK_EMOTES).toBe(3);
    expect(R.FLAG_POOL_SIZE).toBe(33);
    expect(R.CEREMONY_MIN_PARTICIPANTS).toBe(3);
    expect(R.CLAN_NAME_LENGTH).toEqual({ min: 3, max: 32 });
    expect(R.CLAN_TAG_LENGTH).toEqual({ min: 2, max: 5 });
    expect(R.DECLARATIONS_PER_PLAYER).toBe(1);
    expect(R.MIN_BASE_SPACING_M).toBe(200);
    expect(R.WATCH_ZONE_RADIUS_M).toBe(100);
    expect(R.JOIN_PRESENCE_RADIUS_M).toBe(50);
    expect(R.CLAN_SIZE_CAP).toBe(10);
    expect(R.ALPHAS_PER_WEEK).toBe(3);
    expect(R.KD_MIN_KILLS).toBe(10);
    expect(R.VAULT_CODE_DIGITS).toBe(4);
    expect(R.TRAVEL_POINTS).toBe(209);
    expect(R.HUB_DESTINATIONS).toBe(31);
    expect(R.WATCHTOWER_MAX_HEIGHT).toEqual({ grounded: 2, onStructure: 1 });
    expect(R.POINTS_TOP).toBe(200);
    expect(R.POINTS_BOTTOM).toBe(100);
    expect(R.POINTS_UNRANKED).toBe(100);
    expect(R.VOTE_THRESHOLD).toEqual({ num: 2, den: 3 });
    expect(R.HUB_POSITION).toEqual({ x: 100, z: 93 });
    expect(R.RAID_WINDOW).toEqual({ openDow: 5, closeDow: 1 });
  });

  it("⚠️ keeps the released grace strictly shorter than the rebind cooldown", () => {
    // Spec §4.2: equal or longer lets a clan ping-pong two private bases.
    expect(R.RELEASED_POLE_GRACE_MS).toBeLessThan(R.REBIND_COOLDOWN_MS);
  });

  it("⚠️ keeps the watch zone at half the spacing so zones never overlap", () => {
    expect(R.WATCH_ZONE_RADIUS_M * 2).toBeLessThanOrEqual(R.MIN_BASE_SPACING_M);
  });
});
