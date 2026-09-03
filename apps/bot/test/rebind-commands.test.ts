import { describe, it, expect, vi } from "vitest";
import { handleFactionRebind, handleRebindConfirm, type RebindDeps } from "../src/rebind-commands.js";
import { REBIND_COOLDOWN_MS, type QualifyingRaise } from "../src/rebind.js";
import type { RebindStore, RebindTarget } from "../src/rebind-store.js";
import type { Membership, RosterStore } from "../src/roster-store.js";

const now = new Date("2026-09-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const membership: Membership = {
  factionId: 1, serverId: 1, serverName: "S1",
  factionName: "Bears", tag: "BEAR", role: "leader",
};

const target: RebindTarget = {
  id: 1, serverId: 1, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
  poleKey: "1.00:1.00:1.00", status: "active", reboundAt: null,
};

const candidate: QualifyingRaise = {
  poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
  dayzId: "A".repeat(40), gamertag: "Scout", occurredAt: ago(60_000),
};

const deps = (over: {
  memberships?: Membership[];
  faction?: RebindTarget | null;
  raises?: QualifyingRaise[];
  rebind?: RebindStore["rebind"];
} = {}): RebindDeps => ({
  store: { membershipsFor: async () => over.memberships ?? [membership] } as unknown as RosterStore,
  rebindStore: {
    factionFor: async () => (over.faction === undefined ? target : over.faction),
    qualifyingRaises: async () => over.raises ?? [candidate],
    rebind: over.rebind ?? (async () => true),
  },
  now: () => now,
  rebindCooldownMs: REBIND_COOLDOWN_MS,
});

describe("handleFactionRebind", () => {
  it("offers a candidate pole with a confirm button", async () => {
    const r = await handleFactionRebind(deps(), "leader", null);
    expect(r.ephemeral).toBe(true);
    expect(r.content).toContain("9.00:8.00:7.00");
    expect(r.prompt).toEqual({
      kind: "confirm-rebind", factionId: 1, poleKey: "9.00:8.00:7.00",
    });
  });

  it("refuses a player with no faction", async () => {
    const r = await handleFactionRebind(deps({ memberships: [] }), "nobody", null);
    expect(r.content).toBe("You are not in a faction.");
    expect(r.prompt).toBeUndefined();
  });

  it("refuses a non-leader", async () => {
    const r = await handleFactionRebind(
      deps({ memberships: [{ ...membership, role: "officer" }] }), "officer", null);
    expect(r.content).toContain("Only the leader");
    expect(r.prompt).toBeUndefined();
  });

  it("⚠️ names all three requirements when nothing qualifies", async () => {
    // A bare "not found" leaves the leader with no idea which of the three
    // conditions they missed, and the most likely one — raising White out of
    // habit, as the founding ritual asks — is invisible from the log.
    const r = await handleFactionRebind(deps({ raises: [] }), "leader", null);
    expect(r.content).toContain("Flag_Bear");
    expect(r.content).toContain("nobody holds");
    expect(r.content).toContain("roster");
    expect(r.prompt).toBeUndefined();
  });

  it("reports the cooldown with a date", async () => {
    const r = await handleFactionRebind(
      deps({ faction: { ...target, reboundAt: ago(1000) } }), "leader", null);
    expect(r.content).toContain("moved too recently");
    expect(r.prompt).toBeUndefined();
  });

  it("refuses a reserved faction", async () => {
    const r = await handleFactionRebind(
      deps({ faction: { ...target, status: "reserved" } }), "leader", null);
    expect(r.content).toContain("not active yet");
    expect(r.prompt).toBeUndefined();
  });

  it("lists several candidates without a button when the choice is ambiguous", async () => {
    const second: QualifyingRaise = { ...candidate, poleKey: "5.00:5.00:5.00", occurredAt: ago(120_000) };
    const r = await handleFactionRebind(deps({ raises: [candidate, second] }), "leader", null);
    expect(r.content).toContain("9.00:8.00:7.00");
    expect(r.content).toContain("5.00:5.00:5.00");
    expect(r.prompt).toBeUndefined();
  });
});

describe("handleRebindConfirm", () => {
  it("moves the base and says so", async () => {
    const rebind = vi.fn().mockResolvedValue(true);
    const r = await handleRebindConfirm(deps({ rebind }), "leader", 1, "9.00:8.00:7.00");
    expect(rebind).toHaveBeenCalledWith(expect.objectContaining({
      factionId: 1, leaderDiscordId: "leader",
      expectedPoleKey: "1.00:1.00:1.00", poleKey: "9.00:8.00:7.00", x: 9, y: 8, z: 7,
    }));
    expect(r.content).toContain("moved");
    expect(r.content).toContain("3 days");
  });

  it("⚠️ refuses a confirm whose pole is no longer a candidate", async () => {
    // The button carries a pole key from a reply that may be minutes old. If
    // the raise aged out or the pole was claimed in between, confirming must
    // re-derive rather than trust the custom id.
    const r = await handleRebindConfirm(deps({ raises: [] }), "leader", 1, "9.00:8.00:7.00");
    expect(r.content).toContain("no longer");
  });

  it("reports a lost race without claiming success", async () => {
    const r = await handleRebindConfirm(deps({ rebind: async () => false }), "leader", 1, "9.00:8.00:7.00");
    expect(r.content).toContain("could not be moved");
  });
});
