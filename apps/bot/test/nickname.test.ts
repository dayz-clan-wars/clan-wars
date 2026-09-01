import { describe, it, expect } from "vitest";
import { applyNickname, type GuildLike } from "../src/nickname.js";

type FakeGuildOptions = {
  ownerId?: string;
  manageable?: boolean;
  hasPermission?: boolean;
  throws?: Error;
};

function fakeGuild(opts: FakeGuildOptions = {}): GuildLike & { calls: [string, string | null][] } {
  const {
    ownerId = "owner",
    manageable = true,
    hasPermission = true,
    throws,
  } = opts;
  const calls: [string, string | null][] = [];
  return {
    ownerId,
    calls,
    members: {
      async fetch(userId: string) {
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
    members_me_permissions_has: () => hasPermission,
  };
}

describe("applyNickname", () => {
  it("sets the nickname to the gamertag", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", "Ronald")).toBe("ok");
    expect(guild.calls).toEqual([["u1", "Ronald"]]);
  });

  it("clears the nickname when given null", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", null)).toBe("ok");
    expect(guild.calls).toEqual([["u1", null]]);
  });

  it("reports the owner as a PERMANENT refusal", async () => {
    // ⚠️ Discord's API cannot rename a guild owner, ever. Retrying is futile,
    // and treating it as transient would mean retrying forever.
    const guild = fakeGuild({ ownerId: "u1" });
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
    expect(await applyNickname(fakeGuild({ throws: new Error("boom") }), "u1", "R")).toBe("failed");
  });

  it("does not attempt a fetch when the missing-permission check refuses first", async () => {
    // Guards against a regression that swaps the order of the owner/permission
    // checks and the fetch attempt — the outranked/no-permission distinction
    // depends on the permission check running before any fetch.
    const guild = fakeGuild({ hasPermission: false, throws: new Error("should never be called") });
    expect(await applyNickname(guild, "u1", "R")).toBe("no-permission");
  });
});
