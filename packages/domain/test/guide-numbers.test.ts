import { describe, it, expect } from "vitest";
import { GUIDE_NUMBERS, GUIDE_GROUPS, guideNumber } from "../src/guide-numbers.js";
import * as R from "../src/rules.js";

/**
 * The guide's numbers, stated once. Until 2026-09-07 the appendix was
 * hand-typed HTML held to rules.ts by a drift test over a vendored JSON; now
 * the appendix and every number in the chapters render FROM this module, so
 * drift cannot be expressed. What this test pins instead: the appendix still
 * has every row it had, in order; the formatter is honest about units; and
 * every row's key resolves.
 */
const LABELS = [
  "Link: emotes to perform", "Link: time limit",
  "Flags in the pool", "Ceremony: linked players required", "Ceremony: window", "Claim window after ceremony", "Activation window after claim", "Clan name length", "Clan tag length",
  "Declarations per player", "New pole grace before public", "Released pole grace before public", "Minimum distance between declared bases", "Watch zone radius", "Solo declaration lapses after (no raise by declarant)",
  "Same clan raiding the same victim counts once per", "Raid window (base damage on)",
  "Flag-down clock", "Inactivity → dormant", "Dormant → disbanded",
  "Points: raid on #1 / bottom / unranked", "Alpha week", "Alphas per week", "Season", "After a wipe: raise your flag to bind a new base within", "Player board: minimum kills for K/D",
  "Clan size cap", "Join: presence radius at base", "Invite / request / pending no-show expiry", "Leave / kick cooldown", "Leader silent before a succession claim", "Succession: objection window", "No-confidence vote: length", "No-confidence vote: threshold", "Failed vote cooldown", "Rename cooldown", "Old name / tag held after rename or disband", "Base move: confirm window", "Base move: cooldown between moves", "Vault code length",
  "Guest pass",
  "Position fix cadence", "Intruder: alert cooldown per player", "Intruder: pin drops off after", "Pin lifetime",
  "Fast travel points (outhouses, wells, bus stops)", "Hub destinations",
  "Combat log rule", "Watchtower height",
];

describe("GUIDE_NUMBERS (the appendix)", () => {
  it("has the 49 rows the hand-typed table had, in order", () => {
    expect(GUIDE_NUMBERS.map((r) => r.label)).toEqual(LABELS);
  });
  it("groups in the guide's chapter order", () => {
    expect(GUIDE_GROUPS).toEqual(["Getting in", "Founding", "Bases", "Raiding", "Defending", "The scoreboard", "Running a clan", "Discord", "The map", "Getting around", "Fair play"]);
    for (const r of GUIDE_NUMBERS) expect(GUIDE_GROUPS).toContain(r.group);
  });
  it("every row's key resolves to its own value", () => {
    for (const r of GUIDE_NUMBERS) expect(guideNumber(r.key)).toBe(r.value);
  });
  it("renders the values the guide promised", () => {
    const v = Object.fromEntries(GUIDE_NUMBERS.map((r) => [r.label, r.value]));
    expect(v["Link: time limit"]).toBe("24 h");
    expect(v["Flags in the pool"]).toBe(`${R.FLAG_POOL_SIZE} (white is neutral)`);
    expect(v["Points: raid on #1 / bottom / unranked"]).toBe("200 / 100 / 100");
    expect(v["No-confidence vote: threshold"]).toBe("⅔ of all full members");
    expect(v["Watchtower height"]).toBe("2 (1 on a structure)");
  });
});

describe("guideNumber (prose tokens)", () => {
  it("formats durations in the guide's own words", () => {
    expect(guideNumber("FLAG_DOWN_MS", "hours")).toBe("24 hours");
    expect(guideNumber("FLAG_DOWN_MS", "h")).toBe("24 h");
    expect(guideNumber("FLAG_DOWN_MS", "n")).toBe("24");
    expect(guideNumber("DORMANT_AFTER_MS", "days")).toBe("7 days");
    expect(guideNumber("RELEASED_POLE_GRACE_MS", "days")).toBe("3 days");
    expect(guideNumber("CEREMONY_WINDOW_MS", "minutes")).toBe("10 minutes");
    expect(guideNumber("POSITION_FIX_MS", "min")).toBe("5 min");
  });
  it("formats distances and counts", () => {
    expect(guideNumber("WATCH_ZONE_RADIUS_M", "m")).toBe("100 m");
    expect(guideNumber("MIN_BASE_SPACING_M")).toBe("200 m");
    expect(guideNumber("CLAN_SIZE_CAP")).toBe("10");
    expect(guideNumber("KD_MIN_KILLS", "n")).toBe("10");
  });
  it("⚠️ refuses a format that does not fit the unit, and an unknown key", () => {
    expect(() => guideNumber("WATCH_ZONE_RADIUS_M", "days")).toThrow();
    expect(() => guideNumber("FLAG_DOWN_MS", "m")).toThrow();
    expect(() => guideNumber("NOT_A_RULE")).toThrow();
  });
  it("⚠️ the vote threshold text is the fraction rules.ts states", () => {
    expect(`${R.VOTE_THRESHOLD.num}/${R.VOTE_THRESHOLD.den}`).toBe("2/3");
  });
});
