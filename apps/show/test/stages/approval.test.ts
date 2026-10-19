import { describe, it, expect } from "vitest";
import type { Discord } from "../../src/engine/publish/discord.js";
import { APPROVE, REJECT, decideDraft } from "../../src/stages/approval.js";

function discordWith(reactions: Record<string, string[]>): Discord {
  return {
    me: async () => "BOT",
    reactionUserIds: async (_c: string, _m: string, e: string) => reactions[e] ?? [],
  } as unknown as Discord;
}

describe("decideDraft", () => {
  it("an approver's ✅ approves", async () => {
    const d = { discord: discordWith({ [APPROVE]: ["BOT", "ADMIN1"] }), approverIds: ["ADMIN1"] };
    expect(await decideDraft(d, "OPS", "m1")).toEqual({ decision: "approved", by: "ADMIN1" });
  });

  it("an approver's ❌ beats another approver's ✅", async () => {
    const d = { discord: discordWith({ [APPROVE]: ["ADMIN1"], [REJECT]: ["ADMIN2"] }), approverIds: ["ADMIN1", "ADMIN2"] };
    expect(await decideDraft(d, "OPS", "m1")).toEqual({ decision: "rejected", by: "ADMIN2" });
  });

  it("the bot's own ✅ is never a vote, even when the bot is listed as an approver", async () => {
    const d = { discord: discordWith({ [APPROVE]: ["BOT"] }), approverIds: ["BOT"] };
    expect(await decideDraft(d, "OPS", "m1")).toBeNull();
  });

  it("a non-approver's ✅ does nothing", async () => {
    const d = { discord: discordWith({ [APPROVE]: ["RANDOM"] }), approverIds: ["ADMIN1"] };
    expect(await decideDraft(d, "OPS", "m1")).toBeNull();
  });
});
