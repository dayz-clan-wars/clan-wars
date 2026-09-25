import { describe, it, expect, vi } from "vitest";
import { writeScript, screenScript } from "../../src/script/write-script.js";
import type { Moderate } from "../../src/screening/moderate.js";
import type { StoryContext } from "../../src/story/types.js";

const context = {
  week: { start: "a", end: "b", season: 1, episode: 3 }, clans: [], raids: [], flagEvents: [], friendlyFire: [], clanBeefs: [],
  players: { topKillers: [], mostDeaths: [], longestShots: [], oddDeaths: [] }, bounties: [], koth: [], airdrops: [], previous: null,
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
    expect(r).toMatchObject({ ok: true, title: "The Curse", attempts: 1 });
    const [system, user] = generate.mock.calls[0]!;
    expect(system).toMatch(/Bloodbag/u);
    expect(user).toContain('"episode":3');
  });

  it("regenerates once after a script that fails the screen", async () => {
    const generate = vi.fn().mockResolvedValueOnce(reply("\nBoris: EvilTag again.")).mockResolvedValueOnce(reply());
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
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

  it("⚠️ a blocked name surfaced only in a storyline's players is caught, not just dialogue", async () => {
    const withStorylinePlayer = `${dialogue()}\n===STORYLINES===\n${JSON.stringify({ title: "The Curse", storylines: [{ title: "t", players: ["EvilTag"], clans: [], status: "s", openQuestions: [] }] })}`;
    const generate = vi.fn(async () => withStorylinePlayer);
    const r = await writeScript(context, ["EvilTag"], { generate, moderate: allow });
    expect(r).toEqual({ ok: false, attempts: 2, reasons: ['attempt 1: blocked text: "EvilTag"', 'attempt 2: blocked text: "EvilTag"'] });
  });
});
