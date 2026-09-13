import { describe, it, expect } from "vitest";
import { discordLeadershipCopy } from "@factions/copy";
import { leadGroup } from "../src/commands/lead.js";
import { specOf, componentOf, input, ctxWith } from "./command-fakes.js";

const spec = (path: string) => specOf(leadGroup, path);

describe("/lead claim", () => {
  it("asks first, writes on the press", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimSuccession: async () => { seen.push("ran"); return "ok"; } });
    const asked = await spec("lead claim").handler(ctx, input());
    expect(seen).toEqual([]);
    expect(asked.content).toBe(discordLeadershipCopy("claim-succession", "unconfirmed"));
    expect(asked.components).toHaveLength(1);
    const pressed = await componentOf(leadGroup, "claim")(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(seen).toEqual(["ran"]);
    expect(pressed.content).toBe(discordLeadershipCopy("claim-succession", "ok"));
  });

  it("renders every claim outcome", async () => {
    for (const o of ["ok", "claim-open", "is-leader", "not-eligible", "leader-active",
                     "not-member", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ claimSuccession: async () => o });
      expect((await componentOf(leadGroup, "claim")(ctx, { actorDiscordId: "111", arg: null, values: [] })).content, o)
        .toBe(discordLeadershipCopy("claim-succession", o));
    }
  });

  it("every reply is ephemeral, prompt and press alike", async () => {
    const ctx = ctxWith({ claimSuccession: async () => "ok" });
    const asked = await spec("lead claim").handler(ctx, input());
    expect(asked.ephemeral).toBe(true);
    const pressed = await componentOf(leadGroup, "claim")(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(pressed.ephemeral).toBe(true);
  });
});

describe("/lead vote", () => {
  it("carries the nominee through the confirm button, without writing from the slash handler", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ openVote: async (a: string, n: string) => { seen.push([a, n]); return { outcome: "ok", voteId: 1 }; } });
    const asked = await spec("lead vote").handler(ctx, input({ nominee: "222" }));
    expect(seen).toEqual([]);
    expect(asked.content).toBe(discordLeadershipCopy("open-vote", "unconfirmed"));
    expect(asked.components).toHaveLength(1);
    const pressed = await componentOf(leadGroup, "vote")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(seen).toEqual([["111", "222"]]);
    expect(pressed.content).toBe(discordLeadershipCopy("open-vote", "ok"));
  });

  it("refuses without a nominee, without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ openVote: async () => { seen.push("ran"); return { outcome: "ok", voteId: 1 }; } });
    const reply = await spec("lead vote").handler(ctx, input({}));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });

  it("tells the presser to restart when the button lost its nominee", async () => {
    const ctx = ctxWith({ openVote: async () => ({ outcome: "ok", voteId: 1 }) });
    const reply = await componentOf(leadGroup, "vote")(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(reply.content).toContain("/lead vote");
  });

  it("renders every open-vote outcome on the button press", async () => {
    for (const o of ["ok", "passed", "cooldown", "vote-open", "nominee-is-leader", "nominee-not-member",
                     "is-leader", "not-member", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ openVote: async () => ({ outcome: o, voteId: null }) });
      const reply = await componentOf(leadGroup, "vote")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
      expect(reply.content, o).toBe(discordLeadershipCopy("open-vote", o));
    }
  });

  it("every reply is ephemeral, prompt and press alike", async () => {
    const ctx = ctxWith({ openVote: async () => ({ outcome: "ok", voteId: 1 }) });
    const asked = await spec("lead vote").handler(ctx, input({ nominee: "222" }));
    expect(asked.ephemeral).toBe(true);
    const pressed = await componentOf(leadGroup, "vote")(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(pressed.ephemeral).toBe(true);
  });
});

describe("/lead ballot", () => {
  /** R3: no confirm. The site does not gate casting a ballot either. */
  it("casts immediately, with no confirm button", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ castVote: async () => { seen.push("ran"); return "passed"; } });
    const reply = await spec("lead ballot").handler(ctx, input());
    expect(seen).toEqual(["ran"]);
    expect(reply.components).toBeUndefined();
    expect(reply.content).toBe(discordLeadershipCopy("cast-vote", "passed"));
    expect(reply.ephemeral).toBe(true);
  });

  it("renders every cast outcome", async () => {
    for (const o of ["ok", "passed", "already-voted", "not-in-electorate", "no-vote",
                     "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ castVote: async () => o });
      expect((await spec("lead ballot").handler(ctx, input())).content, o).toBe(discordLeadershipCopy("cast-vote", o));
    }
  });
});

describe("/lead has no components leaking beyond claim and vote", () => {
  it("ballot has no confirm action registered", () => {
    expect(leadGroup.components?.["ballot"]).toBeUndefined();
  });
});
