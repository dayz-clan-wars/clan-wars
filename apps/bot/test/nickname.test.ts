import { describe, it, expect, vi } from "vitest";
import { applyNickname, type GuildLike } from "../src/nickname.js";

type FakeGuildOptions = {
  ownerId?: string;
  manageable?: boolean;
  hasPermission?: boolean;
  throws?: Error;
  /** Make the permission predicate itself throw — see the test below. */
  permissionThrows?: Error;
};

function fakeGuild(opts: FakeGuildOptions = {}): GuildLike & { calls: [string, string | null][] } {
  const {
    ownerId = "owner",
    manageable = true,
    hasPermission = true,
    throws,
    permissionThrows,
  } = opts;
  const calls: [string, string | null][] = [];
  return {
    ownerId,
    calls,
    members: {
      async fetch(userId: string) {
        // Recording the attempt (not just a successful setNickname) is what
        // gives the owner-refusal test below teeth: if the owner check ever
        // moved below this fetch, the fetch would run and this array would
        // stop being empty.
        calls.push([userId, "__fetch__"]);
        if (throws) throw throws;
        return {
          manageable,
          async setNickname(nick: string | null) {
            calls.push([userId, nick]);
            return undefined;
          },
        };
      },
    },
    members_me_permissions_has: () => {
      if (permissionThrows) throw permissionThrows;
      return hasPermission;
    },
  };
}

describe("applyNickname", () => {
  it("returns failed when the PERMISSION PREDICATE itself throws", async () => {
    // ⚠️ Regression guard for a real defect: the owner comparison and this
    // predicate once sat OUTSIDE the try. In production the predicate is
    // `guild.members.me?.permissions.has(...)`, so a throw there escaped
    // applyNickname, escaped the adapter, and landed in notifyCompleted's
    // catch BEFORE send and markNotified — no DM, the row stayed pending,
    // and it retried on every tick forever. Move those checks back outside
    // the try and this test goes red.
    const guild = fakeGuild({ permissionThrows: new Error("permissions unavailable") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await applyNickname(guild, "u1", "Ronald")).toBe("failed");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns failed when reading the guild owner throws", async () => {
    // Same hazard on the other predicate: `ownerId` can throw on a partial
    // or uncached Guild.
    const guild = fakeGuild();
    Object.defineProperty(guild, "ownerId", {
      get() { throw new Error("guild not cached"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await applyNickname(guild, "u1", "Ronald")).toBe("failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("sets the nickname to the gamertag", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", "Ronald")).toBe("ok");
    expect(guild.calls).toEqual([["u1", "__fetch__"], ["u1", "Ronald"]]);
  });

  it("clears the nickname when given null", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", null)).toBe("ok");
    expect(guild.calls).toEqual([["u1", "__fetch__"], ["u1", null]]);
  });

  it("truncates a nickname over Discord's 32-character cap instead of failing", async () => {
    // Discord rejects a longer nickname with a REST 400, and a gamertag
    // doesn't get shorter on retry — truncating is what keeps this from
    // reporting "failed" forever for a long gamertag.
    const guild = fakeGuild();
    const thirtyThree = "A".repeat(33);
    expect(await applyNickname(guild, "u1", thirtyThree)).toBe("ok");
    expect(guild.calls.at(-1)).toEqual(["u1", "A".repeat(32)]);
  });

  it("leaves a nickname at exactly the 32-character cap untouched", async () => {
    const guild = fakeGuild();
    const thirtyTwo = "B".repeat(32);
    expect(await applyNickname(guild, "u1", thirtyTwo)).toBe("ok");
    expect(guild.calls.at(-1)).toEqual(["u1", thirtyTwo]);
  });

  it("reports the owner as a PERMANENT refusal", async () => {
    // ⚠️ Discord's API cannot rename a guild owner, ever. Retrying is futile,
    // and treating it as transient would mean retrying forever.
    //
    // The fetch here throws if it is ever reached, so this test has teeth
    // against a regression that moves the owner check below the fetch: such
    // a regression would hit the throw, land in "failed", and this
    // assertion would catch it rather than passing by accident.
    const guild = fakeGuild({ ownerId: "u1", throws: new Error("should never be attempted") });
    expect(await applyNickname(guild, "u1", "Ronald")).toBe("is-owner");
    expect(guild.calls).toEqual([]); // never even attempted
  });

  it("distinguishes a hierarchy refusal from a missing permission", async () => {
    // 50013 covers both "your role is too low" and "you lack Manage
    // Nicknames". They need different messages: one is fixable by the admin
    // moving the bot's role, the other by granting a permission.
    expect(await applyNickname(fakeGuild({ manageable: false }), "u1", "R")).toBe("outranked");
    expect(await applyNickname(fakeGuild({ hasPermission: false }), "u1", "R")).toBe("no-permission");
  });

  it("reports an unexpected API error as failed without throwing", async () => {
    // A link must never be lost because a rename failed.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await applyNickname(fakeGuild({ throws: new Error("boom") }), "u1", "R")).toBe("failed");
    // Reported, not silent — but kept out of the test output so a genuine
    // error in a CI log stands out instead of blending into expected noise.
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("u1"), expect.any(Error));
    warned.mockRestore();
  });

  it("does not attempt a fetch when the missing-permission check refuses first", async () => {
    // Guards against a regression that swaps the order of the owner/permission
    // checks and the fetch attempt — the outranked/no-permission distinction
    // depends on the permission check running before any fetch.
    const guild = fakeGuild({ hasPermission: false, throws: new Error("should never be called") });
    expect(await applyNickname(guild, "u1", "R")).toBe("no-permission");
    expect(guild.calls).toEqual([]);
  });
});
