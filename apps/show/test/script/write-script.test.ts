import { describe, it, expect, vi } from "vitest";
import { writeScript, screenScript } from "../../src/script/write-script.js";
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
    expect(trimUser).toContain("Cut it to under 5,500 characters");
    expect(trimUser).toContain('"episode":3');
  });

  it("⚠️ trims again on the second attempt when both the first reply and its trim are too long", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const generate = vi.fn()
      .mockResolvedValueOnce(tooLong)
      .mockResolvedValueOnce(tooLong)
      .mockResolvedValueOnce(reply());
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("⚠️ holds after both attempts and their trims all come back too long, with all four reasons", async () => {
    const tooLong = reply("\n" + "Boris: " + "a".repeat(6000));
    const generate = vi.fn(async () => tooLong);
    const r = await writeScript(context, [], { generate, moderate: allow });
    expect(r.ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(4);
    if (!r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.reasons).toHaveLength(4);
      expect(r.reasons[0]).toMatch(/^attempt 1: script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[1]).toMatch(/^attempt 1 \(trimmed\): script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[2]).toMatch(/^attempt 2: script is \d+ characters, cap is 6000$/u);
      expect(r.reasons[3]).toMatch(/^attempt 2 \(trimmed\): script is \d+ characters, cap is 6000$/u);
    }
  });

  it("⚠️ a blocked name surfaced only in a storyline's players is caught, not just dialogue", async () => {
    const withStorylinePlayer = `${dialogue()}\n===STORYLINES===\n${JSON.stringify({ title: "The Curse", storylines: [{ title: "t", players: ["EvilTag"], clans: [], status: "s", openQuestions: [] }] })}`;
    const generate = vi.fn(async () => withStorylinePlayer);
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toEqual({ ok: false, attempts: 2, reasons: ['attempt 1: blocked text: "EvilTag"', 'attempt 2: blocked text: "EvilTag"'] });
  });
});
