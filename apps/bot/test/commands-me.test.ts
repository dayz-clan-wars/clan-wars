import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import { meGroup } from "../src/commands/me.js";
import { specOf, sourceOf, input, ctxWith } from "./command-fakes.js";

const spec = (path: string) => specOf(meGroup, path);

describe("/me accept", () => {
  it("passes the chosen invite id through as a number and renders the table's copy", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async (d: string, id: number) => { seen.push([d, id]); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "42" }));
    expect(seen).toEqual([["111", 42]]);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(discordCopy("accept", "ok"));
  });

  it("refuses a non-numeric invite id without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "not-a-number" }));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });

  it("renders every outcome the roster can return", async () => {
    for (const outcome of ["ok", "gone", "already-member", "cooldown", "not-holding", "link-changed", "cap", "not-linked"] as const) {
      const ctx = ctxWith({ acceptInvite: async () => outcome });
      const reply = await spec("me accept").handler(ctx, input({ invite: "1" }));
      expect(reply.content, outcome).toBe(discordCopy("accept", outcome));
    }
  });
});

describe("/me decline and /me withdraw", () => {
  it("maps the boolean the store returns onto the table's two keys", async () => {
    for (const [ok, key] of [[true, "declined"], [false, "gone"]] as const) {
      const ctx = ctxWith({ declineInvite: async () => ok });
      expect((await spec("me decline").handler(ctx, input({ invite: "1" }))).content).toBe(discordCopy("decline", key));
    }
    for (const [ok, key] of [[true, "withdrawn"], [false, "gone"]] as const) {
      const ctx = ctxWith({ withdrawRequest: async () => ok });
      expect((await spec("me withdraw").handler(ctx, input({ request: "1" }))).content).toBe(discordCopy("withdraw", key));
    }
  });
});

describe("/me autocomplete", () => {
  it("offers only this actor's own open invites", async () => {
    const ctx = ctxWith({
      myInvites: async (d: string) => (d === "111"
        ? [{ id: 7, clanId: 1, clanName: "Wolves", tag: "WLF", serverId: 1, serverName: "s", expiresAt: new Date() }]
        : []),
    });
    const choices = await sourceOf(meGroup, "me accept", "invite")(ctx, { actorDiscordId: "111", value: "" });
    expect(choices).toEqual([{ name: "Wolves [WLF]", value: "7" }]);
  });
});
