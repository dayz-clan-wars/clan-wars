import { describe, it, expect } from "vitest";
import { warLogText } from "../src/war-log-text.js";

const siteBaseUrl = "https://dayzclanwars.com";

describe("warLogText", () => {
  it("renders a clan raid", () => {
    expect(warLogText({
      kind: "raid",
      payload: { raiderClan: "Wolves", raiderTag: "WLV", victimClan: "Bears", victimTag: "BRS", gamertag: "Wolfie", solo: false, points: 3 },
    }, siteBaseUrl)).toBe("⚔️ **Wolves** raided **Bears** — flag lowered by Wolfie");
  });

  it("renders a solo raid", () => {
    expect(warLogText({
      kind: "raid",
      payload: { raiderClan: null, raiderTag: null, victimClan: "Bears", victimTag: "BRS", gamertag: "Loner", solo: true, points: 0 },
    }, siteBaseUrl)).toBe("⚔️ **Bears** was raided — flag lowered by Loner (no clan)");
  });

  it("renders a defense with duration", () => {
    expect(warLogText({
      kind: "defense",
      payload: { victimClan: "Bears", victimTag: "BRS", gamertag: "Bear1", durationSeconds: 11700 },
    }, siteBaseUrl)).toBe("🛡️ **Bears** raised their colors again — 3h 15m under siege");
  });

  it("renders week_closed with three", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: "Wolves", third: "Foxes", p1: 30, p2: 20, p3: 10 },
    }, siteBaseUrl)).toBe("🏆 Alphas this week: **Bears**, **Wolves**, **Foxes** — 30 / 20 / 10");
  });

  it("renders week_closed with two", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: "Wolves", third: null, p1: 300, p2: 200, p3: null },
    }, siteBaseUrl)).toBe("🏆 Alphas this week: **Bears**, **Wolves** — 300 / 200");
  });

  it("renders week_closed with one", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: null, third: null, p1: 300, p2: null, p3: null },
    }, siteBaseUrl)).toBe("🏆 Alphas this week: **Bears** — 300");
  });

  it("renders week_closed with nobody scoring", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: null, second: null, third: null, p1: 0, p2: 0, p3: 0 },
    }, siteBaseUrl)).toBe("🏆 No Alphas this week — nobody scored.");
  });

  it("renders season_closed with the seasons link", () => {
    expect(warLogText({
      kind: "season_closed",
      payload: { number: 1, clan: "Bears", points: 150 },
    }, siteBaseUrl)).toBe("🏁 Season 1 is over. Champion: **Bears** with 150. Full table: https://dayzclanwars.com/seasons");
  });
});
