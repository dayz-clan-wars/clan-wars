import { describe, it, expect, beforeEach } from "vitest";
import type { BoardKind } from "@factions/roster";
import { crownTick, type CrownStore } from "../src/crown-tick.js";
import { FakeGuild } from "./fake-guild.js";

/** Every board wired to a role of the same name, so a test names the board and means the role. */
const ALL_ROLES = {
  raiders: "r-raiders",
  killers: "r-killers",
  kd: "r-kd",
  streaks: "r-streaks",
  longestKills: "r-longestKills",
  builders: "r-builders",
  playTime: "r-playTime",
  deaths: "r-deaths",
  friendlyFire: "r-friendlyFire",
} as const satisfies Record<BoardKind, string>;

/** A store that answers with exactly what a test hands it. */
function storeOf(holders: Partial<Record<BoardKind, string[]>>): CrownStore {
  return {
    topHolders: async () =>
      new Map(Object.entries(holders).map(([kind, ids]) => [kind as BoardKind, new Set(ids)])),
  };
}

const throwingStore: CrownStore = {
  topHolders: async () => {
    throw new Error("board read failed");
  },
};

describe("crownTick", () => {
  let guild: FakeGuild;

  beforeEach(() => {
    guild = new FakeGuild();
    for (const roleId of Object.values(ALL_ROLES)) {
      guild.roles.set(roleId, { name: roleId, members: new Set(), mentionable: true });
    }
    for (const id of ["d1", "d2", "d3"]) guild.members.set(id, { nickname: null });
  });

  it("gives each crown to its board's #1", async () => {
    const r = await crownTick(storeOf({ killers: ["d1"], builders: ["d2"] }), guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 2, removes: 0, errors: 0 });
    expect(guild.roleMembers("r-killers")).toEqual(new Set(["d1"]));
    expect(guild.roleMembers("r-builders")).toEqual(new Set(["d2"]));
  });

  it("is idempotent: a second pass with the same #1 issues no writes", async () => {
    const store = storeOf({ killers: ["d1"] });
    await crownTick(store, guild, { roleIds: ALL_ROLES });
    guild.calls.length = 0;
    const r = await crownTick(store, guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 0, removes: 0, errors: 0 });
    expect(guild.calls).toEqual([]);
  });

  it("moves the crown when a new player takes #1", async () => {
    await crownTick(storeOf({ killers: ["d1"] }), guild, { roleIds: ALL_ROLES });
    const r = await crownTick(storeOf({ killers: ["d2"] }), guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 1, removes: 1, errors: 0 });
    expect(guild.roleMembers("r-killers")).toEqual(new Set(["d2"]));
  });

  it("gives the crown to every player tied at the top", async () => {
    const r = await crownTick(storeOf({ streaks: ["d1", "d2"] }), guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 2, removes: 0, errors: 0 });
    expect(guild.roleMembers("r-streaks")).toEqual(new Set(["d1", "d2"]));
  });

  it("strips the crown when the board goes empty", async () => {
    await crownTick(storeOf({ killers: ["d1"] }), guild, { roleIds: ALL_ROLES });
    const r = await crownTick(storeOf({}), guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 0, removes: 1, errors: 0 });
    expect(guild.roleMembers("r-killers")).toEqual(new Set());
  });

  it("never touches a board with no role id configured", async () => {
    const r = await crownTick(storeOf({ killers: ["d1"], deaths: ["d2"] }), guild, {
      roleIds: { killers: "r-killers" },
    });
    expect(r).toEqual({ adds: 1, removes: 0, errors: 0 });
    expect(guild.roleMembers("r-deaths")).toEqual(new Set());
  });

  it("skips a #1 who is not in the guild, and strips one who has left", async () => {
    guild.roles.get("r-killers")!.members.add("gone");
    const r = await crownTick(storeOf({ killers: ["absent"], builders: ["d1"] }), guild, { roleIds: ALL_ROLES });
    expect(r).toEqual({ adds: 1, removes: 1, errors: 0 });
    expect(guild.roleMembers("r-killers")).toEqual(new Set());
  });

  it("⚠️ writes nothing at all when the board read fails, rather than stripping every crown", async () => {
    guild.roles.get("r-killers")!.members.add("d1");
    const errors: string[] = [];
    const r = await crownTick(throwingStore, guild, {
      roleIds: ALL_ROLES,
      onError: (what) => errors.push(what),
    });
    expect(r).toEqual({ adds: 0, removes: 0, errors: 1 });
    expect(errors).toEqual(["boards-read"]);
    expect(guild.roleMembers("r-killers")).toEqual(new Set(["d1"]));
  });

  it("one failing role write does not stop the other boards", async () => {
    guild.failNext.add("addRole");
    const errors: string[] = [];
    const r = await crownTick(storeOf({ raiders: ["d1"], killers: ["d2"], builders: ["d3"] }), guild, {
      roleIds: ALL_ROLES,
      onError: (what) => errors.push(what),
    });
    expect(r).toMatchObject({ adds: 2, errors: 1 });
    expect(errors).toEqual(["raiders-add:d1"]);
    expect(guild.roleMembers("r-killers")).toEqual(new Set(["d2"]));
    expect(guild.roleMembers("r-builders")).toEqual(new Set(["d3"]));
  });
});
