import { describe, it, expect, beforeEach } from "vitest";
import type { Scoreboard } from "@factions/roster";
import type { ScoreboardPost } from "../src/scoreboard-post.js";
import { scoreboardTick, type ScoreboardChannel, type ScoreboardState } from "../src/scoreboard-tick.js";

const boardWith = (points: number): Scoreboard => ({
  season: { number: 3, startedAt: new Date(0), weekClosedThrough: null },
  rows: [{ rank: 1, tag: "Z2", name: "Zone 2", texture: "Flag_Bear", status: "active", points, raids: 1, timesRaided: 0, defenses: 0, alpha: false }],
});
const render = (b: Scoreboard): ScoreboardPost => ({ content: "head", embeds: [{ description: String(b.rows[0]?.points) }] });

class FakeChannel implements ScoreboardChannel {
  live = new Map<string, ScoreboardPost>();
  calls: string[] = [];
  failNextEdit = false;
  private n = 0;
  async findMine() {
    this.calls.push("findMine");
    return [...this.live.keys()][0] ?? null;
  }
  async post(p: ScoreboardPost) {
    this.calls.push("post");
    const id = `m${++this.n}`;
    this.live.set(id, p);
    return id;
  }
  async edit(id: string, p: ScoreboardPost) {
    this.calls.push(`edit:${id}`);
    if (this.failNextEdit) { this.failNextEdit = false; throw new Error("edit failed"); }
    if (!this.live.has(id)) throw new Error("Unknown Message");
    this.live.set(id, p);
  }
}

describe("scoreboardTick", () => {
  let channel: FakeChannel;
  let state: ScoreboardState;
  beforeEach(() => { channel = new FakeChannel(); state = { messageId: null, key: null }; });
  const tick = (points: number) => scoreboardTick({ read: async () => boardWith(points) }, channel, state, render);

  it("posts once into an empty channel, then leaves an unchanged board alone", async () => {
    expect(await tick(100)).toMatchObject({ posted: true, edited: false });
    expect(await tick(100)).toMatchObject({ posted: false, edited: false, errors: 0 });
    expect(channel.calls).toEqual(["findMine", "post", "findMine"]);
  });

  it("edits the same post in place when the standings change", async () => {
    await tick(100);
    expect(await tick(200)).toMatchObject({ edited: true });
    expect(channel.live.size).toBe(1);
    expect(channel.live.get("m1")?.embeds[0]!.description).toBe("200");
  });

  it("adopts the post already in the channel after a restart instead of posting another", async () => {
    await tick(100);
    state = { messageId: null, key: null };
    await tick(100);
    expect(channel.calls.filter((c) => c === "post")).toHaveLength(1);
    expect(channel.calls.at(-1)).toBe("edit:m1");
  });

  it("writes nothing when the standings read fails", async () => {
    await tick(100);
    const r = await scoreboardTick({ read: async () => { throw new Error("db down"); } }, channel, state, render);
    expect(r.errors).toBe(1);
    expect(channel.calls).toEqual(["findMine", "post"]);
  });

  it("retries a failed edit on the next pass", async () => {
    await tick(100);
    channel.failNextEdit = true;
    expect((await tick(200)).errors).toBe(1);
    expect(await tick(200)).toMatchObject({ edited: true });
    expect(channel.live.get("m1")?.embeds[0]!.description).toBe("200");
  });

  it("puts a deleted post back on the next pass, even with no score change", async () => {
    await tick(100);
    channel.live.clear();
    expect(await tick(100)).toMatchObject({ posted: true, errors: 0 });
    expect(channel.live.size).toBe(1);
  });
});
