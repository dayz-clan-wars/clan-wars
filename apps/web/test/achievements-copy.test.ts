import { describe, it, expect } from "vitest";
import { GROUP_LABELS, GROUP_COLORS, TOAST, progressLine, earnedLine, freshUnlocks } from "../lib/achievements-copy";
import { ACHIEVEMENT_GROUP_COLORS } from "@factions/domain";

const tile = (o: Partial<Parameters<typeof progressLine>[0]>) => ({ key: "ten_down", name: "Ten Down", description: "10 PvP kills", group: "pvp", owner: "player", target: 10, unit: "count", earnedAt: null, count: 3, clanTag: null, ...o }) as Parameters<typeof progressLine>[0];

describe("achievement copy", () => {
  it("labels the four groups in the player's words", () => {
    expect(GROUP_LABELS).toEqual({ solo: "Solo", pve: "Survival", pvp: "Combat", team: "Clan" });
  });
  it("progress reads count over target in the tile's unit; one-shots have no progress line", () => {
    expect(progressLine(tile({}))).toBe("3 / 10");
    expect(progressLine(tile({ key: "veteran", unit: "hours", count: 17, target: 100 }))).toBe("17 / 100 h");
    expect(progressLine(tile({ key: "loyalist", unit: "days", count: 12, target: 30 }))).toBe("12 / 30 days");
    expect(progressLine(tile({ key: "marksman", unit: "m", count: 90, target: 150 }))).toBe("best 90 m of 150 m");
    expect(progressLine(tile({ key: "first_blood", target: 1 }))).toBeNull();
  });
  it("a 'less than' rule has no monotone progress — point_blank is a one-shot in practice", () => {
    expect(progressLine(tile({ key: "point_blank", unit: "m", count: 0, target: 5 }))).toBeNull();
  });
  it("an earned tile says when, and with which clan for a team tile", () => {
    expect(earnedLine(tile({ earnedAt: new Date("2026-09-03T10:00:00Z") }))).toBe("Earned 3 Sept");
    expect(earnedLine(tile({ earnedAt: new Date("2026-09-03T10:00:00Z"), clanTag: "BEAR", group: "team" }))).toBe("Earned 3 Sept with BEAR");
  });
});

describe("GROUP_COLORS", () => {
  it("are the domain's, one per group", () => {
    expect(GROUP_COLORS).toEqual(ACHIEVEMENT_GROUP_COLORS);
    expect(Object.keys(GROUP_COLORS).sort()).toEqual(Object.keys(GROUP_LABELS).sort());
  });
});

describe("freshUnlocks — what the owner's page toasts", () => {
  const now = new Date("2026-09-12T12:00:00Z");
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
  it("is the viewer's own player-scoped unlocks from the last week, newest first, at most three", () => {
    const tiles = [
      tile({ key: "enlisted", earnedAt: at(1) }),
      tile({ key: "first_blood", earnedAt: at(0.5) }),
      tile({ key: "ten_down", earnedAt: at(6.9) }),
      tile({ key: "wanderer", earnedAt: at(3) }),
      tile({ key: "veteran", earnedAt: at(8) }),                      // last week is a tile, not a toast
      tile({ key: "champions", group: "team", owner: "clan", earnedAt: at(0.1), clanTag: "BEAR" }),   // the clan's, not the viewer's
      tile({ key: "sniper", earnedAt: null }),
    ];
    expect(freshUnlocks(tiles, now).map((t) => t.key)).toEqual(["first_blood", "enlisted", "wanderer"]);
    expect(freshUnlocks(tiles, now, 10).map((t) => t.key)).toEqual(["first_blood", "enlisted", "wanderer", "ten_down"]);
  });
  it("says which group in the kicker", () => {
    expect(TOAST.kicker("pvp")).toBe("Achievement unlocked · Combat");
    expect(TOAST.kicker("team")).toBe("Achievement unlocked · Clan");
    expect(TOAST.windowDays).toBe(7);
  });
});
