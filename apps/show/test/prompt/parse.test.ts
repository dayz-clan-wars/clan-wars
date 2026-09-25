import { describe, it, expect } from "vitest";
import { parseEpisode, normalizeDashes, EpisodeParseError, MAX_NARRATIVE_CHARS } from "../../src/prompt/parse.js";

const dialogue = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? `Boris: Line ${i}.` : `Pavel: Line ${i}.`)).join("\n");
const block = JSON.stringify({ title: "The Curse", storylines: [{ title: "The House of SNA", players: ["GoldSkull588"], clans: ["SNA"], status: "Civil war.", openQuestions: ["Who is next?"] }] });
const reply = (d = dialogue, b = block) => `${d}\n===STORYLINES===\n${b}`;

describe("parseEpisode", () => {
  it("splits dialogue from the storylines block", () => {
    const p = parseEpisode(reply());
    expect(p.narrative).toBe(dialogue);
    expect(p.title).toBe("The Curse");
    expect(p.storylines[0]!.players).toEqual(["GoldSkull588"]);
  });

  it("⚠️ splits on the LAST marker, so a quoted pitch containing it cannot break the parse", () => {
    const d = `${dialogue}\nPavel: Their pitch is literally "===STORYLINES===". I don't know why.`;
    const p = parseEpisode(reply(d));
    expect(p.narrative).toContain('"===STORYLINES==="');
    expect(p.title).toBe("The Curse");
  });

  it("tolerates a fenced block and markdown-bold speaker names", () => {
    const d = dialogue.replace("Boris: Line 0.", "**Boris:** Line 0.");
    const p = parseEpisode(reply(d, "```json\n" + block + "\n```"));
    expect(p.narrative.split("\n")[0]).toBe("Boris: Line 0.");
  });

  it("replaces em dashes with commas in the script, title and storylines", () => {
    const d = dialogue.replace("Line 2.", "Well \u2014 maybe.");
    const b = block.replace("The Curse", "The \u2014 Curse").replace("Civil war.", "War \u2014 again.");
    const p = parseEpisode(reply(d, b));
    expect(p.narrative).toContain("Well, maybe.");
    expect(p.title).toBe("The, Curse");
    expect(p.storylines[0]!.status).toBe("War, again.");
    expect(JSON.stringify(p)).not.toContain("\u2014");
  });

  it("normalizes em dashes in storyline players and clans, not just title and status", () => {
    const b = block.replace('"GoldSkull588"', '"Gold\u2014Skull"');
    const p = parseEpisode(reply(dialogue, b));
    expect(p.storylines[0]!.players).toEqual(["Gold, Skull"]);
    expect(JSON.stringify(p)).not.toContain("\u2014");
  });

  it.each([
    ["no marker", dialogue],
    ["a stage direction", reply(`${dialogue}\n(Boris stands up)`)],
    ["too short", reply("Boris: Hi.\nPavel: Bye.")],
    ["too long", reply(`${dialogue}\n${"Boris: " + "a".repeat(MAX_NARRATIVE_CHARS)}`)],
    ["a non-JSON block", reply(dialogue, "the storylines are great")],
    ["a missing title", reply(dialogue, JSON.stringify({ storylines: [] }))],
    ["a long title", reply(dialogue, block.replace("The Curse", "x".repeat(41)))],
    ["no storylines", reply(dialogue, JSON.stringify({ title: "T", storylines: [] }))],
    ["a malformed storyline", reply(dialogue, JSON.stringify({ title: "T", storylines: [{ title: "x", players: "Gold" }] }))],
    ["a narrator line", reply(`${dialogue}\nNarrator: Meanwhile, elsewhere.`)],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseEpisode(raw)).toThrow(EpisodeParseError);
  });

  it("⚠️ marks the over-cap rejection with reason \"too_long\", and the length that triggered it", () => {
    const raw = reply(`${dialogue}\n${"Boris: " + "a".repeat(MAX_NARRATIVE_CHARS)}`);
    try {
      parseEpisode(raw);
      expect.fail("expected parseEpisode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EpisodeParseError);
      const e = err as EpisodeParseError;
      expect(e.reason).toBe("too_long");
      expect(e.length).toBeGreaterThan(MAX_NARRATIVE_CHARS);
    }
  });

  it("normalizes an em-dash-led dialogue line", () => {
    const d = dialogue.replace("Pavel: Line 1.", "Pavel: " + "\u2014" + " Oh no.");
    const p = parseEpisode(reply(d));
    expect(p.narrative.split("\n")[1]).toBe("Pavel: Oh no.");
  });

  it("tolerates a leading bullet before the speaker", () => {
    const d = dialogue.replace("Boris: Line 0.", "- Boris: Line 0.");
    const p = parseEpisode(reply(d));
    expect(p.narrative.split("\n")[0]).toBe("Boris: Line 0.");
  });
});

describe("normalizeDashes", () => {
  it("never leaves a comma before a full stop", () => {
    expect(normalizeDashes("Wait \u2014.")).toBe("Wait.");
  });

  it("never leaves a leading comma when the dash opens the string", () => {
    expect(normalizeDashes("\u2014 Well then.")).toBe("Well then.");
  });

  it("collapses a run of adjacent em dashes into one comma", () => {
    expect(normalizeDashes("Wait \u2014\u2014 really?")).toBe("Wait, really?");
  });

  it("collapses a run of space-separated em dashes into one comma", () => {
    expect(normalizeDashes("Wait \u2014 \u2014 really?")).toBe("Wait, really?");
  });

  it("never leaves a comma right after a speaker colon", () => {
    expect(normalizeDashes("Boris: \u2014 Well.")).toBe("Boris: Well.");
  });
});
