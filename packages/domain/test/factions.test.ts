import { describe, it, expect } from "vitest";
import { HOLDING_STATUSES, SUPPLIED_STATUSES } from "../src/factions.js";

describe("faction status sets", () => {
  it("holds identity for reserved, active and dormant", () => {
    // ⚠️ Mirrored by three partial unique indexes in SQL. Changing this
    // without changing them releases a dormant faction's flag, tag and pole.
    expect([...HOLDING_STATUSES]).toEqual(["reserved", "active", "dormant"]);
  });

  it("supplies reserved and active only", () => {
    // Dormant is the whole point: a faction whose flag stopped flying keeps
    // its identity and loses its kit.
    expect([...SUPPLIED_STATUSES]).toEqual(["reserved", "active"]);
  });

  it("every supplied status also holds its pole", () => {
    // A faction receiving supplies at a pole it does not hold is incoherent.
    for (const s of SUPPLIED_STATUSES) expect(HOLDING_STATUSES).toContain(s);
  });
});
