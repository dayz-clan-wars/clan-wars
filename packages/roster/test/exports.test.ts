import { describe, it, expect } from "vitest";
import { ROSTER_EXPORTS } from "./roster-exports";

export { ROSTER_EXPORTS } from "./roster-exports";

describe("@factions/roster exports exactly its allowlist", () => {
  it("matches", async () => {
    const mod = await import("../src/index");
    expect(Object.keys(mod).sort()).toEqual([...ROSTER_EXPORTS].sort());
  });

  it("exports nothing that could set a clan active or dormant, write a raid, or bind a pole", async () => {
    const mod = await import("../src/index");
    const names = Object.keys(mod).map((n) => n.toLowerCase());
    for (const bad of ["activate", "dormant", "raid", "defense", "declaration", "reserve", "createfaction", "insert"]) {
      expect(names.filter((n) => n.includes(bad))).toEqual([]);
    }
  });
});
