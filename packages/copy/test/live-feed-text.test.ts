import { describe, it, expect } from "vitest";
import { clanFeedCard, warLogLine, banLine, achievementLine, onlineLine, ONLINE_TITLE, ONLINE_EMPTY, flagDownDuration, type Line, type Seg } from "../src/index";

const plain = (l: Line): string => l.map((s: Seg): string => {
  if (typeof s === "string") return s;
  if ("text" in s) return s.text;
  if ("raw" in s) return s.raw;
  if ("bold" in s) return plain(s.bold);
  if ("player" in s) return s.player;
  if ("clan" in s) return s.name ? `${s.name} [${s.clan}]` : s.clan;
  if ("time" in s) return `<${s.style}>`;
  return s.label;
}).join("");

const P = { name: "Wolves", tag: "WLF", texture: "Flag_Wolf" };

describe("clanFeedCard", () => {
  it("titles with name and tag and links the clan", () => {
    const c = clanFeedCard("founded", { ...P, actor: "Alpha" });
    expect(plain(c.title)).toBe("Wolves [WLF]");
    expect(c.href).toBe("/clans/WLF");
    expect(plain(c.lines[0]!)).toBe("Founded by Alpha. The ritual is complete — the flag is reserved.");
  });
  it("never says where a base moved", () => {
    expect(plain(clanFeedCard("rebound", { ...P, actor: "Alpha" }).lines[0]!)).toBe("Moved its base by Alpha.");
  });
  it("adds the pool date to a dormant clan only when it parses", () => {
    expect(plain(clanFeedCard("dormant", { ...P, disbandAt: "2026-10-01T00:00:00.000Z" }).lines[0]!))
      .toBe("Gone dormant — the flag has not been raised, and supplies are cut. The flag, tag and pole return to the pool <rel>.");
    expect(plain(clanFeedCard("dormant", { ...P, disbandAt: "not a date" }).lines[0]!))
      .toBe("Gone dormant — the flag has not been raised, and supplies are cut.");
  });
  it("names the flag back in the pool on a lapse", () => {
    expect(plain(clanFeedCard("lapsed", P).lines[0]!)).toBe("Never raised their flag. Wolf is back in the pool.");
  });
});

describe("warLogLine", () => {
  it("credits the raider and the player who lowered the flag", () => {
    expect(plain(warLogLine("raid", { raiderClan: "Bears", raiderTag: "BRS", victimClan: "Wolves", victimTag: "WLF", gamertag: "Alpha" })))
      .toBe("⚔️ Bears [BRS] raided Wolves [WLF] — flag lowered by Alpha");
  });
  it("drops the close time when it does not parse, never prints Invalid Date", () => {
    const l = plain(warLogLine("season_closed", { number: 2, clan: null }, "garbage"));
    expect(l).toBe("🏁 Season 2 is over. Nobody scored. Full table: seasons");
    expect(l).not.toMatch(/Invalid|NaN/u);
  });
  it("reports an empty week", () => {
    expect(plain(warLogLine("week_closed", { first: null }))).toBe("🏆 No Alphas this week — nobody scored.");
  });
});

describe("banLine", () => {
  it("drops the until clause when expiresAt does not parse", () => {
    expect(plain(banLine({ kind: "applied", gamertag: "Alpha", reason: "zone", expiresAt: "nope" }))).not.toMatch(/Invalid|NaN|until/u);
  });
  it("says unbanned when served", () => {
    expect(plain(banLine({ kind: "expired", gamertag: "Alpha", reason: "zone", expiresAt: null }))).toBe("🔓 Alpha unbanned — ban served.");
  });
});

describe("achievementLine", () => {
  it("never prints a Discord id for a player with no gamertag", () => {
    const l = plain(achievementLine({ ownerKind: "player", ownerName: "123456789012345678", gamertag: null, name: "First Blood", description: "Get a kill" }));
    expect(l).toBe("A player unlocked First Blood · Get a kill");
    expect(l).not.toMatch(/\d{6,}/u);
  });
  it("links a clan by tag", () => {
    expect(achievementLine({ ownerKind: "clan", clanTag: "WLF", ownerName: "Wolves", name: "N", description: "D" })[0]).toEqual({ bold: [{ clan: "WLF" }] });
  });
});

describe("online", () => {
  it("lists a player with their tag and connect time", () => {
    expect(plain(onlineLine({ gamertag: "Alpha", tag: "WLF", connectedAt: "2026-09-08T00:00:00.000Z" }))).toBe("Alpha [WLF] · on since <rel>");
    expect(ONLINE_TITLE(3)).toBe("Players online · 3");
    expect(ONLINE_EMPTY).toBe("Nobody on the server.");
  });
  it("formats flag-down time as hours and minutes", () => {
    expect(flagDownDuration(11_100)).toBe("3h 5m");
  });
});
