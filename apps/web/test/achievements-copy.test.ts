import { describe, it, expect } from "vitest";
import { GROUP_LABELS, progressLine, earnedLine } from "../lib/achievements-copy";

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
