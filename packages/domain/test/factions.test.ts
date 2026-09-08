import { describe, it, expect } from "vitest";
import { HOLDING_STATUSES, SUPPLIED_PREDICATE } from "../src/factions.js";

describe("faction status sets", () => {
  it("holds identity for reserved, active and dormant", () => {
    // ⚠️ Mirrored by three partial unique indexes in SQL. Changing this
    // without changing them releases a dormant faction's flag, tag and pole.
    expect([...HOLDING_STATUSES]).toEqual(["reserved", "active", "dormant"]);
  });

  it("supplied is a predicate, not a status list: active with the flag up", () => {
    // ⚠️ Reserved is IN. The kit is the only source of the clan's own flag,
    // and raising that flag is what activates the clan — an active-only
    // predicate is a dead end nobody can activate out of (2026-09-08, COK and
    // NIGHT both stuck). Dormant is out; a raided-but-active clan keeps its
    // 24h clock and loses its kit the moment flag_down_since is set.
    expect(SUPPLIED_PREDICATE).toBe("status in ('reserved', 'active') and flag_down_since is null");
  });
});
