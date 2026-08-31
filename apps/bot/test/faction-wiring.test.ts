import { describe, it, expect } from "vitest";
import { buildCommands, claimCustomId, parseClaimCustomId } from "../src/discord.js";

describe("faction wiring", () => {
  it("registers /faction claim with its three options", () => {
    const faction = buildCommands().find((c) => c.name === "faction");
    expect(faction).toBeDefined();
    const claim = (faction as { options?: { name: string; options?: { name: string }[] }[] })
      .options?.find((o) => o.name === "claim");
    expect(claim?.options?.map((o) => o.name)).toEqual(["name", "tag", "flag"]);
  });

  it("round-trips a ceremony id through a custom id", () => {
    expect(parseClaimCustomId(claimCustomId(42))).toBe(42);
  });

  it("refuses a custom id that is not ours", () => {
    // Discord delivers every component interaction in the guild; a foreign
    // custom id must not be parsed into a ceremony id.
    expect(parseClaimCustomId("something-else")).toBeNull();
    expect(parseClaimCustomId("claim-confirm:notanumber")).toBeNull();
  });

  it("keeps the custom id inside Discord's 100-character limit", () => {
    // The reason a claim draft is a database row rather than encoded here.
    expect(claimCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
  });
});
