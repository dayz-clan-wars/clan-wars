import { describe, it, expect, beforeEach } from "vitest";
import type { APIEmbed } from "discord.js";
import { BOARD_KINDS, type BoardKind, type Boards } from "@factions/roster";
import { leaderboardTick, type LeaderboardChannel, type LeaderboardState, type LeaderboardStore } from "../src/leaderboard-tick.js";

const SITE = "https://dayzclanwars.com";

const boardsOf = (over: Partial<Boards> = {}): Boards => ({
  clans: {}, scope: { kind: "season", number: 2 }, seasons: [2, 1],
  raiders: [], killers: [], deaths: [], kd: [], playTime: [], friendlyFire: [], builders: [], streaks: [], longestKills: [], bountyKills: [],
  ...over,
});

const storeOf = (boards: Boards): LeaderboardStore => ({ read: async () => boards });

/** An in-memory leaderboards channel: ten standing messages, in the order they were sent. */
class FakeChannel implements LeaderboardChannel {
  posted: { kind: BoardKind; embed: APIEmbed }[] = [];
  /** Messages the bot believes exist, keyed by the id it handed out. */
  live = new Map<string, { kind: BoardKind; embed: APIEmbed }>();
  calls: string[] = [];
  failNextEdit = false;
  private n = 0;

  async findMine(): Promise<Map<BoardKind, string>> {
    this.calls.push("findMine");
    const out = new Map<BoardKind, string>();
    for (const [id, m] of this.live) out.set(m.kind, id);
    return out;
  }
  async purgeMine(): Promise<number> {
    this.calls.push("purgeMine");
    const n = this.live.size;
    this.live.clear();
    return n;
  }
  async post(kind: BoardKind, embed: APIEmbed): Promise<string> {
    this.calls.push(`post:${kind}`);
    const id = `m${++this.n}`;
    this.live.set(id, { kind, embed });
    this.posted.push({ kind, embed });
    return id;
  }
  async edit(messageId: string, embed: APIEmbed): Promise<void> {
    this.calls.push(`edit:${messageId}`);
    if (this.failNextEdit) {
      this.failNextEdit = false;
      throw new Error("edit failed");
    }
    const m = this.live.get(messageId);
    if (m === undefined) throw new Error("no such message");
    m.embed = embed;
  }
}

const freshState = (): LeaderboardState => ({ messageIds: null, keys: new Map() });

describe("leaderboardTick", () => {
  let channel: FakeChannel;
  let state: LeaderboardState;

  beforeEach(() => {
    channel = new FakeChannel();
    state = freshState();
  });

  it("posts all ten on an empty channel, in the site's order", async () => {
    const r = await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    expect(r).toMatchObject({ posted: 10, edited: 0, errors: 0 });
    expect(channel.posted.map((p) => p.kind)).toEqual([...BOARD_KINDS]);
  });

  it("edits nothing on a second pass when no board moved", async () => {
    const store = storeOf(boardsOf());
    await leaderboardTick(store, channel, state, SITE);
    channel.calls.length = 0;
    const r = await leaderboardTick(store, channel, state, SITE);
    expect(r).toMatchObject({ posted: 0, edited: 0, errors: 0 });
    expect(channel.calls).toEqual([]);
  });

  it("edits only the board that moved", async () => {
    await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    channel.calls.length = 0;
    const moved = boardsOf({ killers: [{ dayzId: "A", gamertag: "Alpha", value: 3 }] });
    const r = await leaderboardTick(storeOf(moved), channel, state, SITE);
    expect(r).toMatchObject({ posted: 0, edited: 1, errors: 0 });
    expect(channel.calls.filter((c) => c.startsWith("edit:"))).toHaveLength(1);
  });

  it("⚠️ rebuilds the whole channel when a message has gone missing, so the ten stay in order", async () => {
    await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    // Someone deleted the killers message by hand.
    const killersId = [...channel.live].find(([, m]) => m.kind === "killers")![0];
    channel.live.delete(killersId);
    state.messageIds = null; // a restart: the tick rediscovers from the channel

    channel.posted.length = 0;
    const r = await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    expect(r).toMatchObject({ posted: 10, rebuilt: true, errors: 0 });
    expect(channel.calls).toContain("purgeMine");
    expect(channel.posted.map((p) => p.kind)).toEqual([...BOARD_KINDS]);
  });

  it("adopts the ten it already posted after a restart, editing rather than reposting", async () => {
    await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    state = freshState(); // restart: ids and keys are gone, the channel is not
    channel.calls.length = 0; // the first pass's own build is not what is under test

    const moved = boardsOf({ builders: [{ dayzId: "B", gamertag: "Bravo", value: 2 }] });
    const r = await leaderboardTick(storeOf(moved), channel, state, SITE);
    expect(r).toMatchObject({ posted: 0, rebuilt: false, errors: 0 });
    // A restart has no remembered keys, so every board is redrawn once.
    expect(r.edited).toBe(10);
    expect(channel.calls).not.toContain("purgeMine");
  });

  it("⚠️ leaves a failed board's key stale so the next pass retries it", async () => {
    await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    const moved = boardsOf({ killers: [{ dayzId: "A", gamertag: "Alpha", value: 3 }] });

    channel.failNextEdit = true;
    const first = await leaderboardTick(storeOf(moved), channel, state, SITE);
    expect(first).toMatchObject({ edited: 0, errors: 1 });

    const second = await leaderboardTick(storeOf(moved), channel, state, SITE);
    expect(second).toMatchObject({ edited: 1, errors: 0 });
  });

  it("one failing board does not stop the others", async () => {
    await leaderboardTick(storeOf(boardsOf()), channel, state, SITE);
    const moved = boardsOf({
      raiders: [{ dayzId: "A", gamertag: "Alpha", value: 1 }],
      killers: [{ dayzId: "B", gamertag: "Bravo", value: 2 }],
      builders: [{ dayzId: "C", gamertag: "Charlie", value: 3 }],
    });
    channel.failNextEdit = true; // raiders is first in BOARD_KINDS
    const errors: string[] = [];
    const r = await leaderboardTick(storeOf(moved), channel, state, SITE, (what) => errors.push(what));
    expect(r).toMatchObject({ edited: 2, errors: 1 });
    expect(errors).toEqual(["raiders"]);
  });

  it("⚠️ writes nothing when the board read fails, rather than blanking ten messages", async () => {
    await leaderboardTick(storeOf(boardsOf({ killers: [{ dayzId: "A", gamertag: "Alpha", value: 9 }] })), channel, state, SITE);
    channel.calls.length = 0;
    const throwing: LeaderboardStore = { read: async () => { throw new Error("boards unavailable"); } };
    const r = await leaderboardTick(throwing, channel, state, SITE);
    expect(r).toMatchObject({ posted: 0, edited: 0, errors: 1 });
    expect(channel.calls).toEqual([]);
  });
});
