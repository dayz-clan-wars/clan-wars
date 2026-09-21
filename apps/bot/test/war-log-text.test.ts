import { describe, it, expect } from "vitest";
import { warLogText } from "../src/war-log-text.js";

const siteBaseUrl = "https://dayzclanwars.com";

describe("warLogText", () => {
  it("links both clans and the raider", () => {
    const line = warLogText({
      kind: "raid",
      payload: { raiderClan: "Nomads", raiderTag: "NOMAD", victimClan: "Vultures", victimTag: "VULT", gamertag: "SomePlayer" },
    }, "https://dayzclanwars.com");
    expect(line).toContain("**[Nomads](<https://dayzclanwars.com/clans/NOMAD>)**");
    expect(line).toContain("**[Vultures](<https://dayzclanwars.com/clans/VULT>)**");
    expect(line).toContain("[SomePlayer](<https://dayzclanwars.com/players/SomePlayer>)");
  });

  it("renders a clan raid", () => {
    expect(warLogText({
      kind: "raid",
      payload: { raiderClan: "Wolves", raiderTag: "WLV", victimClan: "Bears", victimTag: "BRS", gamertag: "Wolfie", solo: false, points: 3 },
    }, siteBaseUrl)).toBe(
      "⚔️ **[Wolves](<https://dayzclanwars.com/clans/WLV>)** [WLV] raided **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS]"
        + " — flag lowered by [Wolfie](<https://dayzclanwars.com/players/Wolfie>)",
    );
  });

  it("renders a solo raid", () => {
    expect(warLogText({
      kind: "raid",
      payload: { raiderClan: null, raiderTag: null, victimClan: "Bears", victimTag: "BRS", gamertag: "Loner", solo: true, points: 0 },
    }, siteBaseUrl)).toBe(
      "⚔️ **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS] was raided — flag lowered by [Loner](<https://dayzclanwars.com/players/Loner>) (no clan)",
    );
  });

  // A raid row written before this task shipped has no raiderTag/victimTag —
  // clan() must fall back to bold-and-unlinked rather than emit a broken link.
  it("a raid with no tag on record renders the clan bold and unlinked", () => {
    expect(warLogText({
      kind: "raid",
      payload: { raiderClan: "Wolves", victimClan: "Bears", gamertag: "Wolfie", solo: false, points: 3 },
    }, siteBaseUrl)).toBe("⚔️ **Wolves** raided **Bears** — flag lowered by [Wolfie](<https://dayzclanwars.com/players/Wolfie>)");
  });

  it("renders a defense with duration", () => {
    expect(warLogText({
      kind: "defense",
      payload: { victimClan: "Bears", victimTag: "BRS", gamertag: "Bear1", durationSeconds: 11700 },
    }, siteBaseUrl)).toBe("🛡️ **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS] raised their colors again — 3h 15m under siege");
  });

  it("renders week_closed with three", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: "Wolves", third: "Foxes", t1: "BRS", t2: "WLV", t3: "FOX", p1: 30, p2: 20, p3: 10 },
    }, siteBaseUrl)).toBe(
      "🏆 Alphas this week: **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS], "
        + "**[Wolves](<https://dayzclanwars.com/clans/WLV>)** [WLV], "
        + "**[Foxes](<https://dayzclanwars.com/clans/FOX>)** [FOX] — 30 / 20 / 10",
    );
  });

  it("renders week_closed with two", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: "Wolves", third: null, t1: "BRS", t2: "WLV", t3: null, p1: 300, p2: 200, p3: null },
    }, siteBaseUrl)).toBe(
      "🏆 Alphas this week: **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS], **[Wolves](<https://dayzclanwars.com/clans/WLV>)** [WLV] — 300 / 200",
    );
  });

  it("renders week_closed with one", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: null, third: null, t1: "BRS", t2: null, t3: null, p1: 300, p2: null, p3: null },
    }, siteBaseUrl)).toBe("🏆 Alphas this week: **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS] — 300");
  });

  it("renders week_closed with nobody scoring", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: null, second: null, third: null, p1: 0, p2: 0, p3: 0 },
    }, siteBaseUrl)).toBe("🏆 No Alphas this week — nobody scored.");
  });

  // ⚠️ This is the arm that will actually run against historical data on
  // deploy: every week_closed row written before this task has no t1/t2/t3.
  it("a week_closed row with no tag on record renders the clan bold and unlinked", () => {
    expect(warLogText({
      kind: "week_closed",
      payload: { first: "Bears", second: null, third: null, t2: null, t3: null, p1: 300, p2: null, p3: null },
    }, siteBaseUrl)).toBe("🏆 Alphas this week: **Bears** — 300");
  });

  it("renders season_closed with the seasons link", () => {
    expect(warLogText({
      kind: "season_closed",
      payload: { number: 1, clan: "Bears", tag: "BRS", points: 150 },
    }, siteBaseUrl)).toBe(
      "🏁 Season 1 is over. Champion: **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS] with 150. Full table: [seasons](<https://dayzclanwars.com/seasons>)",
    );
  });

  it("renders season_closed with no champion", () => {
    expect(warLogText({
      kind: "season_closed",
      payload: { number: 1, clan: null, tag: null, points: null },
    }, siteBaseUrl)).toBe("🏁 Season 1 is over. Nobody scored. Full table: [seasons](<https://dayzclanwars.com/seasons>)");
  });

  it("a season_closed row with no tag on record renders the champion bold and unlinked", () => {
    expect(warLogText({
      kind: "season_closed",
      payload: { number: 1, clan: "Bears", points: 150 },
    }, siteBaseUrl)).toBe("🏁 Season 1 is over. Champion: **Bears** with 150. Full table: [seasons](<https://dayzclanwars.com/seasons>)");
  });

  it("renders season_closed with the close time as a live Discord timestamp", () => {
    expect(warLogText({
      kind: "season_closed",
      occurredAt: new Date("2026-09-30T00:00:00.000Z"),
      payload: { number: 1, clan: "Bears", tag: "BRS", points: 150 },
    }, siteBaseUrl)).toBe(
      "🏁 Season 1 is over <t:1790726400:F>. Champion: **[Bears](<https://dayzclanwars.com/clans/BRS>)** [BRS] with 150. "
        + "Full table: [seasons](<https://dayzclanwars.com/seasons>)",
    );
  });
});
