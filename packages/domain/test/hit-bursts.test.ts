import { describe, it, expect } from "vitest";
import { groupHitBursts, type HitInput } from "../src/hit-bursts.js";

const A = "A".repeat(40); const B = "B".repeat(40); const C = "C".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

let nextId = 0;
function hit(p: Partial<HitInput> & { at: number }): HitInput {
  return {
    eventId: ++nextId, serverId: p.serverId ?? 1, occurredAt: s(p.at),
    attackerType: p.attackerType ?? "player",
    attackerDayzId: p.attackerDayzId === undefined ? A : p.attackerDayzId,
    victimDayzId: p.victimDayzId ?? B,
    weapon: p.weapon === undefined ? "KA-74" : p.weapon,
    damage: p.damage ?? 38, bodyPart: p.bodyPart ?? "Torso",
    distanceM: p.distanceM ?? 41, victimHp: p.victimHp ?? 60,
  };
}

/** Far enough past every hit that nothing is held open by the settle rule. */
const settled = { frontier: s(10_000), windowS: 60 };

describe("groupHitBursts", () => {
  it("runs of hits sharing attacker, victim and weapon become one engagement", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 2 }), hit({ at: 5 })], settled);
    expect(out).toHaveLength(1);
    expect(out[0]!.hits).toHaveLength(3);
    expect(out[0]!.attackerDayzId).toBe(A);
    expect(out[0]!.victimDayzId).toBe(B);
    expect(out[0]!.startedAt).toEqual(s(0));
    expect(out[0]!.endedAt).toEqual(s(5));
    expect(out[0]!.closed).toBe(true);
  });

  it("a gap longer than the window starts a new engagement", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 61 })], settled);
    expect(out).toHaveLength(2);
  });

  it("a gap exactly the window still joins — the window is the maximum gap, inclusive", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 60 })], settled);
    expect(out).toHaveLength(1);
  });

  it("a weapon switch splits, even with no gap at all", () => {
    const out = groupHitBursts([hit({ at: 0, weapon: "KA-74" }), hit({ at: 1, weapon: "Mosin" })], settled);
    expect(out.map((e) => e.weapon)).toEqual(["KA-74", "Mosin"]);
  });

  it("a null weapon is its own key — it never merges with the next named weapon", () => {
    const out = groupHitBursts([hit({ at: 0, weapon: null }), hit({ at: 1, weapon: "Mosin" })], settled);
    expect(out.map((e) => e.weapon)).toEqual([null, "Mosin"]);
  });

  it("different victims of the same attacker are different engagements, interleaved", () => {
    const out = groupHitBursts([hit({ at: 0, victimDayzId: B }), hit({ at: 1, victimDayzId: C }), hit({ at: 2, victimDayzId: B })], settled);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.victimDayzId === B)!.hits).toHaveLength(2);
  });

  it("PvE hits are dropped entirely", () => {
    const out = groupHitBursts([
      hit({ at: 0, attackerType: "infected", attackerDayzId: null }),
      hit({ at: 1, attackerType: "environment", attackerDayzId: null, weapon: null }),
    ], settled);
    expect(out).toEqual([]);
  });

  it("a self-inflicted hit is not PvP", () => {
    const out = groupHitBursts([hit({ at: 0, attackerDayzId: B, victimDayzId: B })], settled);
    expect(out).toEqual([]);
  });

  it("a player hit with no attacker id is dropped rather than grouped under null", () => {
    const out = groupHitBursts([hit({ at: 0, attackerDayzId: null })], settled);
    expect(out).toEqual([]);
  });

  it("⚠️ an engagement stays OPEN until it is settle-clear of the frontier, even when quiet", () => {
    // Quiet for 90s, but a finished death can still claim it up to 120s out.
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(90), windowS: 60 });
    expect(out[0]!.closed).toBe(false);
  });

  it("closes once the frontier is a full settle window past the last hit", () => {
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(120), windowS: 60 });
    expect(out[0]!.closed).toBe(true);
  });

  it("⚠️ a lagging frontier holds everything open — batched ingest must not look like quiet", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 2 })], { frontier: s(2), windowS: 60 });
    expect(out[0]!.closed).toBe(false);
  });

  it("a window longer than the settle floor governs instead", () => {
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(200), windowS: 300 });
    expect(out[0]!.closed).toBe(false);
  });

  it("carries the first and last event ids, and the hits oldest first", () => {
    nextId = 100;
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 1 }), hit({ at: 2 })], settled);
    expect(out[0]!.firstEventId).toBe(101);
    expect(out[0]!.lastEventId).toBe(103);
    expect(out[0]!.hits.map((h) => h.eventId)).toEqual([101, 102, 103]);
  });

  it("returns engagements in first-event order, so the caller can advance a cursor over them", () => {
    const out = groupHitBursts([hit({ at: 0, victimDayzId: C }), hit({ at: 1, victimDayzId: B })], settled);
    expect(out[0]!.victimDayzId).toBe(C);
    expect(out[1]!.victimDayzId).toBe(B);
  });

  it("⚠️ the same pair fighting on two servers does not merge into one engagement", () => {
    const out = groupHitBursts([hit({ at: 0, serverId: 1 }), hit({ at: 1, serverId: 2 }), hit({ at: 2, serverId: 1 })], settled);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.serverId === 1)!.hits).toHaveLength(2);
    expect(out.find((e) => e.serverId === 2)!.hits).toHaveLength(1);
  });
});
