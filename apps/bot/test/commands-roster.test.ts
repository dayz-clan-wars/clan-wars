import { describe, it, expect } from "vitest";
import { discordCopy } from "@factions/copy";
import { rosterGroup } from "../src/commands/roster.js";
import { specOf, sourceOf, componentOf, input, ctxWith } from "./command-fakes.js";

const spec = (path: string) => specOf(rosterGroup, path);

describe("/roster invite", () => {
  it("sends a gamertag as a gamertag ref, not a Discord id", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ invite: async (_a: string, ref: unknown) => { seen.push(ref); return { outcome: "ok", inviteId: 1 }; } });
    await spec("roster invite").handler(ctx, input({ gamertag: "Survivor" }));
    expect(seen).toEqual([{ gamertag: "Survivor" }]);
  });

  it("renders every InviteOutcome from the shared table", async () => {
    for (const o of ["ok", "not-linked", "not-in-clan", "pending", "not-permitted", "already-member",
                     "cooldown", "not-holding", "cap", "invitee-not-linked", "ambiguous-gamertag"] as const) {
      const ctx = ctxWith({ invite: async () => ({ outcome: o, inviteId: null }) });
      expect((await spec("roster invite").handler(ctx, input({ gamertag: "x" }))).content, o).toBe(discordCopy("invite", o));
    }
  });

  it("refuses without a gamertag, without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ invite: async () => { seen.push("ran"); return { outcome: "ok", inviteId: 1 }; } });
    const reply = await spec("roster invite").handler(ctx, input({}));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });
});

describe("/roster revoke", () => {
  it("passes the chosen invite id through as a number", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ revokeInvite: async (a: string, id: number) => { seen.push([a, id]); return "ok"; } });
    const reply = await spec("roster revoke").handler(ctx, input({ invite: "42" }));
    expect(seen).toEqual([["111", 42]]);
    expect(reply.content).toBe(discordCopy("revoke", "ok"));
  });

  it("renders every outcome, including the shared actor refusals", async () => {
    for (const o of ["ok", "not-permitted", "gone", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ revokeInvite: async () => o });
      expect((await spec("roster revoke").handler(ctx, input({ invite: "1" }))).content, o).toBe(discordCopy("revoke", o));
    }
  });

  it("refuses a non-numeric invite id without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ revokeInvite: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("roster revoke").handler(ctx, input({ invite: "not-a-number" }));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });
});

describe("/roster decide", () => {
  it("maps the accept boolean onto accepted/declined and passes the id as a number", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ decideRequest: async (a: string, id: number, decision: string) => { seen.push([a, id, decision]); return "ok"; } });
    await spec("roster decide").handler(ctx, input({ request: "7", accept: true }));
    expect(seen).toEqual([["111", 7, "accepted"]]);
  });

  it("declines when accept is not true", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ decideRequest: async (a: string, id: number, decision: string) => { seen.push(decision); return "ok"; } });
    await spec("roster decide").handler(ctx, input({ request: "7", accept: false }));
    expect(seen).toEqual(["declined"]);
  });

  it("renders every DecideRequestOutcome from the shared table", async () => {
    for (const o of ["ok", "not-permitted", "gone", "cap", "cooldown", "link-changed", "not-recruiting",
                     "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ decideRequest: async () => o });
      expect((await spec("roster decide").handler(ctx, input({ request: "1", accept: true }))).content, o).toBe(discordCopy("decide", o));
    }
  });

  it("refuses without a valid request id", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ decideRequest: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("roster decide").handler(ctx, input({ accept: true }));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });
});

describe("/roster kick", () => {
  it("passes the target's Discord id through", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ kick: async (a: string, t: string) => { seen.push([a, t]); return "ok"; } });
    await spec("roster kick").handler(ctx, input({ member: "222" }));
    expect(seen).toEqual([["111", "222"]]);
  });

  it("renders every KickOutcome from the shared table", async () => {
    for (const o of ["ok", "not-permitted", "target-not-member", "cannot-kick-self", "cannot-kick-officer",
                     "cannot-kick-leader", "vote-open", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ kick: async () => o });
      expect((await spec("roster kick").handler(ctx, input({ member: "222" }))).content, o).toBe(discordCopy("kick", o));
    }
  });

  it("refuses without a chosen member", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ kick: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("roster kick").handler(ctx, input({}));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });
});

describe("/roster promote and demote", () => {
  it("shares the one role table", async () => {
    for (const o of ["ok", "not-leader", "target-not-member", "cannot-target-leader", "not-linked", "not-in-clan", "pending"] as const) {
      for (const path of ["roster promote", "roster demote"]) {
        const ctx = ctxWith({ promote: async () => o, demote: async () => o });
        expect((await spec(path).handler(ctx, input({ member: "222" }))).content, `${path} ${o}`).toBe(discordCopy("role", o));
      }
    }
  });

  it("passes the target's Discord id through for both", async () => {
    const seenPromote: unknown[] = [];
    const seenDemote: unknown[] = [];
    const ctx = ctxWith({
      promote: async (a: string, t: string) => { seenPromote.push([a, t]); return "ok"; },
      demote: async (a: string, t: string) => { seenDemote.push([a, t]); return "ok"; },
    });
    await spec("roster promote").handler(ctx, input({ member: "222" }));
    await spec("roster demote").handler(ctx, input({ member: "222" }));
    expect(seenPromote).toEqual([["111", "222"]]);
    expect(seenDemote).toEqual([["111", "222"]]);
  });

  it("refuses without a chosen member", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ promote: async () => { seen.push("ran"); return "ok"; }, demote: async () => { seen.push("ran"); return "ok"; } });
    expect((await spec("roster promote").handler(ctx, input({}))).content).toContain("Pick");
    expect((await spec("roster demote").handler(ctx, input({}))).content).toContain("Pick");
    expect(seen).toEqual([]);
  });
});

describe("/roster transfer", () => {
  /** R2: the slash command must not write. The button is the write. */
  it("does not call the roster — it asks for a confirm", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ transfer: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("roster transfer").handler(ctx, input({ member: "222" }));
    expect(seen).toEqual([]);
    expect(reply.components).toHaveLength(1);
    expect(reply.content).toBe(discordCopy("transfer", "unconfirmed"));
  });

  it("refuses without a chosen member, without prompting a confirm", async () => {
    const ctx = ctxWith({ transfer: async () => "ok" });
    const reply = await spec("roster transfer").handler(ctx, input({}));
    expect(reply.content).toContain("Pick");
    expect(reply.components).toBeUndefined();
  });

  it("writes when the button is pressed, carrying the target in the custom id", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ transfer: async (a: string, t: string) => { seen.push([a, t]); return "ok"; } });
    const reply = await componentOf(rosterGroup, "transfer")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(seen).toEqual([["111", "222"]]);
    expect(reply.content).toBe(discordCopy("transfer", "ok"));
  });

  it("refuses a press whose custom id lost its target", async () => {
    const ctx = ctxWith({ transfer: async () => "ok" });
    const reply = await componentOf(rosterGroup, "transfer")(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(reply.content).toContain("Run `/roster transfer`");
  });

  it("renders every TransferOutcome from the shared table on the button press", async () => {
    for (const o of ["ok", "not-leader", "target-not-member", "vote-open", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ transfer: async () => o });
      const reply = await componentOf(rosterGroup, "transfer")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
      expect(reply.content, o).toBe(discordCopy("transfer", o));
    }
  });
});

describe("/roster autocomplete", () => {
  it("offers outstanding invites, and nothing when the actor has no clan", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-in-clan" });
    expect(await sourceOf(rosterGroup, "roster revoke", "invite")(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
  });

  it("offers outstanding invites by invitee gamertag, falling back to their Discord id", async () => {
    const ctx = ctxWith({
      clanFor: async () => ({
        invitesOut: [
          { id: 5, inviteeGamertag: "Survivor", inviteeDiscordId: "999" },
          { id: 6, inviteeGamertag: null, inviteeDiscordId: "888" },
        ],
        requestsIn: [],
      }),
    });
    expect(await sourceOf(rosterGroup, "roster revoke", "invite")(ctx, { actorDiscordId: "111", value: "" })).toEqual([
      { name: "Survivor", value: "5" },
      { name: "888", value: "6" },
    ]);
  });

  it("offers incoming requests by gamertag, falling back to their Discord id, and nothing when not linked", async () => {
    const noClan = ctxWith({ clanFor: async () => "not-linked" });
    expect(await sourceOf(rosterGroup, "roster decide", "request")(noClan, { actorDiscordId: "111", value: "" })).toEqual([]);

    const ctx = ctxWith({
      clanFor: async () => ({
        invitesOut: [],
        requestsIn: [
          { id: 9, gamertag: "Looter", discordId: "777" },
          { id: 10, gamertag: null, discordId: "666" },
        ],
      }),
    });
    expect(await sourceOf(rosterGroup, "roster decide", "request")(ctx, { actorDiscordId: "111", value: "" })).toEqual([
      { name: "Looter", value: "9" },
      { name: "666", value: "10" },
    ]);
  });

  it("offers linked gamertag suggestions for invite, scoped to 'linked', and nothing for a blank query", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ suggestGamertags: async (q: string, scope: string) => { seen.push([q, scope]); return ["Survivor", "Survivor2"]; } });
    expect(await sourceOf(rosterGroup, "roster invite", "gamertag")(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
    expect(seen).toEqual([]);

    expect(await sourceOf(rosterGroup, "roster invite", "gamertag")(ctx, { actorDiscordId: "111", value: "Sur" })).toEqual([
      { name: "Survivor", value: "Survivor" },
      { name: "Survivor2", value: "Survivor2" },
    ]);
    expect(seen).toEqual([["Sur", "linked"]]);
  });
});

describe("roster reply ephemerality", () => {
  it("every roster reply is ephemeral, including the transfer confirm and its button press", async () => {
    const ok = { outcome: "ok" as const, inviteId: 1 };
    const ctx = ctxWith({
      invite: async () => ok, revokeInvite: async () => "ok", decideRequest: async () => "ok",
      kick: async () => "ok", promote: async () => "ok", demote: async () => "ok", transfer: async () => "ok",
    });
    for (const path of ["roster invite", "roster revoke", "roster decide", "roster kick", "roster promote", "roster demote", "roster transfer"]) {
      const opts = path === "roster invite" ? { gamertag: "x" }
        : path === "roster revoke" ? { invite: "1" }
        : path === "roster decide" ? { request: "1", accept: true }
        : { member: "222" };
      const reply = await spec(path).handler(ctx, input(opts));
      expect(reply.ephemeral, path).toBe(true);
    }
    const pressed = await componentOf(rosterGroup, "transfer")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(pressed.ephemeral).toBe(true);
  });
});
