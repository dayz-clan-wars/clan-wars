import { describe, it, expect } from "vitest";
import { confirmId, parseCustomId, confirmReply } from "../src/commands/confirm.js";

describe("confirm custom ids", () => {
  it("round-trips an action, an actor and an argument", () => {
    const id = confirmId("disband", "111", undefined);
    expect(parseCustomId(id)).toEqual({ kind: "c", action: "disband", actorDiscordId: "111", arg: null });
    expect(parseCustomId(confirmId("transfer", "111", "222"))).toEqual({
      kind: "c", action: "transfer", actorDiscordId: "111", arg: "222",
    });
  });

  it("ignores a custom id that is not ours", () => {
    expect(parseCustomId("invite-42")).toBeNull();
    expect(parseCustomId("cw:")).toBeNull();
  });

  /**
   * ⚠️ The button lives on an ephemeral message, so in practice only the
   * actor can press it. This is belt and braces: a custom id is
   * attacker-supplied data the moment anything else can echo one back.
   */
  it("carries the actor so the router can refuse a mismatched presser", () => {
    expect(parseCustomId(confirmId("disband", "111"))!.actorDiscordId).toBe("111");
  });

  it("builds an ephemeral reply with exactly one Confirm button", () => {
    const reply = confirmReply("disband", "111", "Press Confirm to disband — this cannot be undone.");
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("Press Confirm");
    expect(reply.components).toHaveLength(1);
  });
});
