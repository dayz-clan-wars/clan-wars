import { describe, it, expect } from "vitest";
import { alertMessage, draftMarker, draftMessage, forumThreadName, heldMessage, opsSafe, publicText, transcriptMessages } from "../../src/stages/text.js";

const MON = new Date("2026-09-21T00:00:00Z");
const allText = (m: { content?: string; embeds?: { description: string }[]; files?: { data: Buffer }[] }) =>
  [m.content ?? "", ...(m.embeds ?? []).map((e) => e.description), ...(m.files ?? []).map((f) => f.data.toString("utf8"))].join("\n");

describe("stage text", () => {
  it("marks a draft by week", () => {
    expect(draftMarker(MON)).toBe("show:2026-09-21");
  });

  it("writes redaction aliases as [REDACTED] in anything public", () => {
    expect(publicText("REDACTED_PLAYER_2 hit REDACTED_CLAN_1")).toBe("[REDACTED] hit [REDACTED]");
  });

  it("names the forum thread per spec §2.4 and caps it at 100", () => {
    expect(forumThreadName("S01E03", "The Curse")).toBe("Clan Wars S01E03 · The Curse");
    expect(forumThreadName("S01E03", "x".repeat(200)).length).toBe(100);
  });

  describe("opsSafe", () => {
    const blocked = ["BadName88"];
    it.each([
      ["attempt 1: blocklist: slurword", "attempt 1: blocklist hit"],
      ['attempt 2: blocked text: "BadName88"', "attempt 2: a blocked name came back"],
      ["attempt 1 (trimmed): moderation: says slurword", "attempt 1 (trimmed): moderation flagged it"],
      ["attempt 1: too long: BadName88 said 7000 characters", "attempt 1: too long: [blocked text] said 7000 characters"],
    ])("%s", (raw, safe) => {
      expect(opsSafe(raw, blocked)).toBe(safe);
    });
    it("masks a blocked string in any case", () => {
      expect(opsSafe("error near badname88", blocked)).toBe("error near [blocked text]");
    });
  });

  it("drafts with the link, the marker, counts not names, and the transcript as a file", () => {
    const m = draftMessage({
      weekStart: MON, code: "S01E03", subtitle: "The Curse", youtubeVideoId: "V1",
      narrative: "Boris: REDACTED_PLAYER_1 again.", scriptAttempts: 2,
      redactions: [{ text: "BadName88", kinds: ["gamertag"], replacement: "REDACTED_PLAYER_1", reason: "blocklist: x", source: "blocklist" }],
    });
    expect(m.content).toContain("https://youtu.be/V1");
    expect(m.content).toContain("show:2026-09-21");
    expect(m.content).toContain("1 name redacted");
    expect(m.content).toContain("attempt 2");
    expect(m.content!.length).toBeLessThanOrEqual(2000);
    expect(m.files![0]!.name).toBe("transcript.txt");
    expect(allText(m)).toContain("[REDACTED] again.");
    expect(allText(m)).not.toContain("BadName88");
  });

  it("holds without naming what tripped", () => {
    const m = heldMessage({ code: "S01E03", weekStart: MON, reasons: ['attempt 1: blocked text: "BadName88"', "attempt 2: blocklist: slurword"], blocked: ["BadName88"] });
    expect(m.content).toContain("S01E03");
    expect(m.content).toContain("pnpm run show --week 2026-09-21 --force");
    expect(m.content).not.toContain("BadName88");
    expect(m.content).not.toContain("slurword");
  });

  it("alerts with the stage, count and a masked, capped error", () => {
    const m = alertMessage({ code: "S01E03", stage: "uploaded", attempts: 3, error: `BadName88 ${"e".repeat(1000)}`, blocked: ["BadName88"] });
    expect(m.content).toContain("uploaded");
    expect(m.content).toContain("3");
    expect(m.content).not.toContain("BadName88");
    expect(m.content!.length).toBeLessThanOrEqual(2000);
  });

  it("splits the transcript into embeds of at most 4,096 and messages of at most 6,000, mp3 on the first", () => {
    const line = "Boris: GoldSkull588 raided again and again and again.\n";
    const narrative = line.repeat(250); // ~13,500 characters before formatting
    const ms = transcriptMessages({ narrative, names: ["GoldSkull588"], mp3: Buffer.from("MP3") });
    expect(ms.length).toBeGreaterThan(1);
    for (const m of ms) {
      const total = (m.embeds ?? []).reduce((n, e) => n + e.description.length, 0);
      expect(total).toBeLessThanOrEqual(6000);
      for (const e of m.embeds ?? []) expect(e.description.length).toBeLessThanOrEqual(4096);
    }
    expect(ms[0]!.files![0]).toMatchObject({ name: "episode.mp3", contentType: "audio/mpeg" });
    expect(ms.slice(1).every((m) => !m.files)).toBe(true);
    expect(ms[0]!.embeds![0]!.description).toContain("**BORIS**");
    expect(ms[0]!.embeds![0]!.description).toContain("`GoldSkull588`");
  });

  it("keeps every public string free of em and en dashes", () => {
    const ms = transcriptMessages({ narrative: "Boris: a — b – c", names: [], mp3: Buffer.from("") });
    expect(allText(ms[0]!)).not.toMatch(/[–—]/u);
  });
});
