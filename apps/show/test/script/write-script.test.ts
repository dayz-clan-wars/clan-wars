import { describe, it, expect, vi } from "vitest";
import { writeScript, screenScript, MAX_FACT_FIXES } from "../../src/script/write-script.js";
import { FactCheckError } from "../../src/script/fact-check.js";
import type { Moderate } from "../../src/screening/moderate.js";
import type { StoryContext } from "../../src/story/types.js";

const context = {
  week: { start: "a", end: "b", season: 1, episode: 3, alpha: null }, clans: [], raids: [], flagEvents: [], memberMoves: [], friendlyFire: [], clanBeefs: [],
  players: { topKillers: [], mostDeaths: [], raidsByPlayer: [], longestShots: [], oddDeaths: [] }, bounties: [], koth: [], airdrops: [], previous: null,
} satisfies StoryContext;

const dialogue = (extra = "") => Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? `Boris: Line ${i}.` : `Pavel: Line ${i}.`)).join("\n") + extra;
const reply = (extra = "") => `${dialogue(extra)}\n===STORYLINES===\n${JSON.stringify({ title: "The Curse", storylines: [{ title: "t", players: [], clans: [], status: "s", openQuestions: [] }] })}`;
const allow: Moderate = async (t) => t.map(() => ({ block: false, reason: "" }));

describe("screenScript", () => {
  it("catches the blocklist, a blocked name the model surfaced (any case), and the moderator", async () => {
    const moderate: Moderate = async () => [{ block: true, reason: "slur" }];
    expect(await screenScript("Pavel: welcome, n4z1 friends", [], allow)).toEqual(["blocklist: nazi"]);
    expect(await screenScript("Boris: EVILTAG strikes", ["EvilTag"], allow)).toEqual(['blocked text: "EvilTag"']);
    expect(await screenScript("Boris: hi", [], moderate)).toEqual(["moderation: slur"]);
    expect(await screenScript("Boris: hi", [], allow)).toEqual([]);
  });

  it("matches a blocked text as a whole word only, not inside a longer word", async () => {
    expect(await screenScript("Boris: the boss has class.", ["SS"], allow)).toEqual([]);
    expect(await screenScript("Pavel: SS again.", ["SS"], allow)).toEqual(['blocked text: "SS"']);
  });

  it("an operator-allowed text is masked from the blocklist and exact search, not from the moderator", async () => {
    const moderate = vi.fn(allow);
    expect(await screenScript("Boris: Heil is a real player.", [], moderate, ["Heil"])).toEqual([]);
    expect(moderate.mock.calls[0]![0]).toEqual(["Boris: Heil is a real player."]);
    expect(await screenScript("Boris: Heil is a real player.", [], allow)).toEqual(["blocklist: heil"]);
  });
});

describe("writeScript", () => {
  it("returns the first script that parses and passes", async () => {
    const generate = vi.fn(async (_system: string, _user: string) => reply());
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, title: "The Curse", attempts: 1, reasons: [] });
    const [system, user] = generate.mock.calls[0]!;
    expect(system).toMatch(/Bloodbag/u);
    expect(user).toContain('"episode":3');
  });

  it("⚠️ a success on attempt 2 still reports why attempt 1 failed", async () => {
    const generate = vi.fn().mockResolvedValueOnce(reply("\nBoris: EvilTag again.")).mockResolvedValueOnce(reply());
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toEqual({ ok: true, narrative: expect.any(String), title: "The Curse", storylines: expect.any(Array), attempts: 2, reasons: ['attempt 1: blocked text: "EvilTag"'] });
  });

  it("passes an operator-allowed name the blocklist would hit, and fails it without the allow", async () => {
    const generate = async () => reply("\nBoris: Heil is a real player.");
    expect(await writeScript(context, [], { generate, moderate: allow, allowed: ["Heil"] })).toMatchObject({ ok: true, attempts: 1 });
    expect(await writeScript(context, [], { generate, moderate: allow })).toEqual({
      ok: false, attempts: 2, reasons: ["attempt 1: blocklist: heil", "attempt 2: blocklist: heil"],
    });
  });

  it("regenerates once after a reply that does not parse", async () => {
    const generate = vi.fn().mockResolvedValueOnce("Boris: no block at all").mockResolvedValueOnce(reply());
    expect(await writeScript(context, [], { generate, moderate: allow })).toMatchObject({ ok: true, attempts: 2 });
  });

  it("⚠️ holds after two failures, with every reason", async () => {
    const generate = vi.fn(async () => reply("\nBoris: EvilTag."));
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toEqual({ ok: false, attempts: 2, reasons: ['attempt 1: blocked text: "EvilTag"', 'attempt 2: blocked text: "EvilTag"'] });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("⚠️ a moderator failure is not a pass: it throws", async () => {
    const moderate: Moderate = async () => { throw new Error("moderation down"); };
    await expect(writeScript(context, [], { generate: async () => reply(), moderate })).rejects.toThrow("moderation down");
  });

  it("⚠️ trims a too-long first reply and screens the trimmed reply like a first draft", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const generate = vi.fn().mockResolvedValueOnce(tooLong).mockResolvedValueOnce(reply());
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(generate).toHaveBeenCalledTimes(2);
    const [, trimUser] = generate.mock.calls[1]!;
    expect(trimUser).toContain("Cut it to under 4,800 characters");
    expect(trimUser).toContain('"episode":3');
  });

  it("⚠️ moves to a second attempt when the first reply and both its trims are too long", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const generate = vi.fn()
      .mockResolvedValueOnce(tooLong)
      .mockResolvedValueOnce(tooLong)
      .mockResolvedValueOnce(tooLong)
      .mockResolvedValueOnce(reply());
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("⚠️ trims a second time when the first trim is still too long, handing back the trimmed reply", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const stillLong = reply("\n" + "Pavel: " + "b".repeat(5900));
    const generate = vi.fn().mockResolvedValueOnce(tooLong).mockResolvedValueOnce(stillLong).mockResolvedValueOnce(reply());
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(generate).toHaveBeenCalledTimes(3);
    const [, secondTrim] = generate.mock.calls[2]!;
    expect(secondTrim).toContain("bbbb");
    expect(secondTrim).not.toContain("aaaa");
    if (r.ok) expect(r.reasons).toEqual([expect.stringMatching(/^attempt 1: script is/u), expect.stringMatching(/^attempt 1 \(trimmed\): script is/u)]);
  });

  it("⚠️ holds after both attempts and both of their trims all come back too long, with all six reasons", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const generate = vi.fn(async () => tooLong);
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r.ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(6);
    if (!r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.reasons).toHaveLength(6);
      expect(r.reasons[0]).toMatch(/^attempt 1: script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[1]).toMatch(/^attempt 1 \(trimmed\): script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[2]).toMatch(/^attempt 1 \(trimmed 2\): script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[3]).toMatch(/^attempt 2: script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[5]).toMatch(/^attempt 2 \(trimmed 2\): script is \d+ characters, cap is 6000$/u);
    }
  });

  it("⚠️ a blocked name surfaced only in a storyline's players is caught, not just dialogue", async () => {
    const withStorylinePlayer = `${dialogue()}\n===STORYLINES===\n${JSON.stringify({ title: "The Curse", storylines: [{ title: "t", players: ["EvilTag"], clans: [], status: "s", openQuestions: [] }] })}`;
    const generate = vi.fn(async () => withStorylinePlayer);
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toEqual({ ok: false, attempts: 2, reasons: ['attempt 1: blocked text: "EvilTag"', 'attempt 2: blocked text: "EvilTag"'] });
  });
});

describe("writeScript fact check", () => {
  const wrong = [{ line: "Boris: Line 0.", problem: "The Admins killed SNA 17 times, not the other way round" }];

  it("sends wrong claims back to the writer and keeps the fixed script once it checks out", async () => {
    const generate = vi.fn().mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply("\nPavel: Fixed."));
    const factCheck = vi.fn().mockResolvedValueOnce(wrong).mockResolvedValueOnce([]);
    const r = await writeScript(context, [], { generate, moderate: allow, factCheck });
    expect(r).toMatchObject({ ok: true, attempts: 1, reasons: [expect.stringMatching(/^attempt 1: fact check: 1 wrong: "Boris: Line 0\." \(The Admins killed SNA 17 times/u)] });
    expect(r.ok && r.narrative).toContain("Pavel: Fixed.");
    // The fix call carries the data, every mistake and the script it is fixing.
    const fixUser = generate.mock.calls[1]![1] as string;
    expect(fixUser).toContain('"episode":3');
    expect(fixUser).toContain('- "Boris: Line 0.": The Admins killed SNA 17 times');
    expect(fixUser).toContain("===STORYLINES===");
    expect(fixUser).toMatch(/the first line of your reply is the first dialogue line/u);
    // The checker reads the script against the same data message the writer got.
    expect(factCheck.mock.calls[0]![1]).toBe(generate.mock.calls[0]![1]);
  });

  it("fails the attempt when claims are still wrong after every fix, then tries a fresh script", async () => {
    const generate = vi.fn(async () => reply());
    const factCheck = vi.fn().mockResolvedValue(wrong);
    const r = await writeScript(context, [], { generate, moderate: allow, factCheck });
    expect(r.ok).toBe(false);
    // Per attempt: one draft plus MAX_FACT_FIXES fixes, each checked.
    expect(generate).toHaveBeenCalledTimes(2 * (1 + MAX_FACT_FIXES));
    expect(factCheck).toHaveBeenCalledTimes(2 * (1 + MAX_FACT_FIXES));
    expect(r.reasons.map((x) => x.split(": fact check")[0])).toEqual([
      "attempt 1", "attempt 1 (fact fix 1)", "attempt 1 (fact fix 2)", "attempt 2", "attempt 2 (fact fix 1)", "attempt 2 (fact fix 2)",
    ]);
  });

  it("screens a fixed script again, like a first draft", async () => {
    const generate = vi.fn().mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply("\nBoris: EvilTag again.")).mockResolvedValue(reply());
    const factCheck = vi.fn().mockResolvedValueOnce(wrong).mockResolvedValue([]);
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow, factCheck });
    expect(r).toMatchObject({ ok: true, attempts: 2, reasons: [expect.stringMatching(/^attempt 1: fact check: 1 wrong/u), 'attempt 1 (fact fix 1): blocked text: "EvilTag"'] });
  });

  it("an unreadable fact-check reply fails the attempt; any other error propagates", async () => {
    const unreadable = vi.fn().mockRejectedValueOnce(new FactCheckError("fact check reply was not JSON")).mockResolvedValue([]);
    const r = await writeScript(context, [], { generate: async () => reply(), moderate: allow, factCheck: unreadable });
    expect(r).toMatchObject({ ok: true, attempts: 2, reasons: ["attempt 1: fact check: fact check reply was not JSON"] });
    const down = vi.fn().mockRejectedValue(new Error("openrouter 503: down"));
    await expect(writeScript(context, [], { generate: async () => reply(), moderate: allow, factCheck: down })).rejects.toThrow("openrouter 503");
  });
});

