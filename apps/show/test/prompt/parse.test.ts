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
  ])("rejects %s", (_label, raw) => {
    expect(() => parseEpisode(raw)).toThrow(EpisodeParseError);
  });
});

describe("normalizeDashes", () => {
  it("never leaves a comma before a full stop", () => {
    expect(normalizeDashes("Wait \u2014.")).toBe("Wait.");
  });
});
