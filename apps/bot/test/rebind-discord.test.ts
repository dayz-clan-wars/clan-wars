import { describe, it, expect } from "vitest";
import { rebindCustomId, parseRebindCustomId, planRosterButtons, buildCommands } from "../src/discord.js";

describe("rebind custom ids", () => {
  it("round-trips a faction id and a pole key", () => {
    const id = rebindCustomId(42, "9.00:8.00:7.00");
    expect(parseRebindCustomId(id)).toEqual({ factionId: 42, poleKey: "9.00:8.00:7.00" });
  });

  it("⚠️ survives the colons in a pole key", () => {
    // A pole key is `x:y:z`, so a naive split(":") would truncate it and the
    // confirm would look for a pole that does not exist.
    expect(parseRebindCustomId(rebindCustomId(1, "-1.50:0.00:2.25")))
      .toEqual({ factionId: 1, poleKey: "-1.50:0.00:2.25" });
  });

  it("rejects a foreign custom id", () => {
    expect(parseRebindCustomId("roster-disband:1")).toBeNull();
    expect(parseRebindCustomId("rebind-confirm:notanumber:1:2:3")).toBeNull();
  });
});

describe("planRosterButtons", () => {
  it("renders one confirm button for a rebind prompt", () => {
    const rows = planRosterButtons({ kind: "confirm-rebind", factionId: 7, poleKey: "1.00:2.00:3.00" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(1);
    expect(rows[0]![0]!.customId).toBe(rebindCustomId(7, "1.00:2.00:3.00"));
    expect(rows[0]![0]!.style).toBe("danger");
  });
});

describe("buildCommands", () => {
  it("registers /faction rebind", () => {
    const faction = buildCommands().find((c) => c.name === "faction") as
      { options: { name: string }[] };
    expect(faction.options.map((o) => o.name)).toContain("rebind");
  });
});
