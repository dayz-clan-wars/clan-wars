import { describe, it, expect } from "vitest";
import { resolveServerContext } from "../src/roster-context.js";
import type { Membership } from "../src/roster-store.js";

const m = (serverId: number, serverName: string): Membership => ({
  factionId: serverId * 10, serverId, serverName,
  factionName: `F${serverId}`, tag: `T${serverId}`, role: "leader",
});

describe("resolveServerContext", () => {
  it("uses the only membership when there is one", () => {
    expect(resolveServerContext([m(1, "S1")], null)).toEqual({ kind: "ok", membership: m(1, "S1") });
  });

  it("refuses when the player holds no faction", () => {
    expect(resolveServerContext([], null)).toEqual({ kind: "no-faction" });
  });

  it("asks which server when the player holds several and named none", () => {
    const r = resolveServerContext([m(1, "S1"), m(2, "S2")], null);
    expect(r).toEqual({ kind: "ambiguous", choices: [m(1, "S1"), m(2, "S2")] });
  });

  it("uses the named server when the player holds several", () => {
    expect(resolveServerContext([m(1, "S1"), m(2, "S2")], 2)).toEqual({ kind: "ok", membership: m(2, "S2") });
  });

  it("refuses a named server the player holds no faction on", () => {
    expect(resolveServerContext([m(1, "S1"), m(2, "S2")], 3)).toEqual({ kind: "not-on-server" });
  });

  it("honours a named server even when it is the only one", () => {
    // A stale autocomplete choice must not silently act on a different faction.
    expect(resolveServerContext([m(1, "S1")], 9)).toEqual({ kind: "not-on-server" });
  });
});
