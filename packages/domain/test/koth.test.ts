import { describe, it, expect } from "vitest";
import {
  kothWanted, inKothZone, kothStandings, kothWinner, restoredPresets, isRestartSlot,
  highWater, isoWeekStart, kothDecisionInstantFor, voteClosesAt,
  KOTH_LOCATIONS, kothLocation, kothTownName, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, KOTH_ZONE_RADIUS_M, WORLD_SIZE_M,
} from "../src/index.js";

const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");

describe("kothWanted", () => {
  const row = (over: Partial<{ slotAt: Date; state: string; announcedAt: Date | null }> = {}) =>
    ({ slotAt: SLOT, state: "scheduled", announcedAt: at("2026-10-01T00:00:00Z"), ...over });
  it("returns the scheduled, announced row for this exact slot", () => {
    const r = row();
    expect(kothWanted(SLOT, [r])).toBe(r);
  });
  // ⚠️ Spec §5.1: a session is never opened without its announcement.
  it("ignores an unannounced row", () => expect(kothWanted(SLOT, [row({ announcedAt: null })])).toBeNull());
  // ⚠️ Spec §2.1: never late.
  it("ignores a row for an earlier slot", () => expect(kothWanted(SLOT, [row({ slotAt: at("2026-10-03T18:00:00Z") })])).toBeNull());
  it("ignores cancelled and failed rows", () => {
    expect(kothWanted(SLOT, [row({ state: "cancelled" }), row({ state: "failed" })])).toBeNull();
  });
});

describe("inKothZone", () => {
  const c = { x: 1000, z: 1000 };
  it("counts 499 and 500 m, not 501", () => {
    expect(inKothZone({ x: 1499, z: 1000 }, c)).toBe(true);
    expect(inKothZone({ x: 1000 + KOTH_ZONE_RADIUS_M, z: 1000 }, c)).toBe(true);
    expect(inKothZone({ x: 1501, z: 1000 }, c)).toBe(false);
  });
  it("a kill we cannot place is not on the hill", () => expect(inKothZone(null, c)).toBe(false));
});

describe("kothStandings", () => {
  const k = (id: string, iso: string) => ({ killerDayzId: id, gamertag: id.toUpperCase(), occurredAt: at(iso) });
  it("ranks by kills, then by who reached that count first", () => {
    const s = kothStandings([
      k("a", "2026-10-03T20:10:00Z"), k("b", "2026-10-03T20:05:00Z"),
      k("b", "2026-10-03T20:30:00Z"), k("a", "2026-10-03T20:20:00Z"),
      k("c", "2026-10-03T20:01:00Z"),
    ]);
    expect(s.map((r) => [r.dayzId, r.kills])).toEqual([["a", 2], ["b", 2], ["c", 1]]);
    expect(s[0]!.reachedAt).toEqual(at("2026-10-03T20:20:00Z"));
  });
  it("is order-independent", () => {
    const kills = [k("a", "2026-10-03T20:10:00Z"), k("b", "2026-10-03T20:05:00Z")];
    expect(kothStandings([...kills].reverse())).toEqual(kothStandings(kills));
  });
});

describe("kothWinner", () => {
  const s = [
    { dayzId: "u", gamertag: "U", kills: 9, reachedAt: SLOT },
    { dayzId: "l", gamertag: "L", kills: 4, reachedAt: SLOT },
  ];
  it("passes the prize down past an unlinked top killer", () => {
    expect(kothWinner(s, (id) => id === "l")?.dayzId).toBe("l");
  });
  it("is null when nobody is linked, or nobody scored", () => {
    expect(kothWinner(s, () => false)).toBeNull();
    expect(kothWinner([], () => true)).toBeNull();
  });
});

describe("restoredPresets", () => {
  const koth = [`./custom/${KOTH_PRESET_PREFIX}ak74-svd.json`];
  it("leaves a list with no koth- entry alone, so a user's own edit survives", () => {
    expect(restoredPresets(["./custom/loadout.json", "./custom/extra.json"], ["./custom/loadout.json"])).toBeNull();
  });
  it("puts the snapshot back over a KotH list", () => {
    expect(restoredPresets(koth, ["./custom/loadout.json"])).toEqual(["./custom/loadout.json"]);
  });
  it("with no snapshot, strips the koth- entries", () => {
    expect(restoredPresets([...koth, "./custom/loadout.json"], null)).toEqual(["./custom/loadout.json"]);
  });
  // ⚠️ An empty preset list is a server where fresh spawns get nothing; refuse.
  it("refuses to produce an empty list", () => expect(() => restoredPresets(koth, null)).toThrow(/empty/));
});

describe("catalogue", () => {
  it("has the 31 Chernarus towns and 44 presets, all flat in ./custom/ with the prefix", () => {
    expect(KOTH_LOCATIONS).toHaveLength(31);
    expect(kothLocation("novaya-petrovka")).toMatchObject({ name: "Novaya Petrovka", spawnGroup: "NovayaPetrovka" });
    expect(kothLocation("narnia")).toBeNull();
    expect(KOTH_PRESET_FILES).toHaveLength(44);
    for (const p of KOTH_PRESET_FILES) expect(p).toMatch(/^\.\/custom\/koth-[a-z0-9-]+\.json$/);
  });
  // ⚠️ Review focus 4: past sessions are Livonia rows, and their names must survive the move.
  it("names a retired Livonia town but never offers one", () => {
    expect(kothTownName("lembork")).toBe("Lembork");
    expect(kothTownName("adamow")).toBe("Adamów");
    expect(kothLocation("lembork")).toBeNull();
    expect(kothTownName("novy-sobor")).toBe("Novy Sobor");
    expect(kothTownName("narnia")).toBe("narnia");
  });
  it("keeps slugs unique and every centre on the map", () => {
    expect(new Set(KOTH_LOCATIONS.map((l) => l.slug)).size).toBe(31);
    for (const l of KOTH_LOCATIONS) {
      expect(l.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(l.centreX).toBeGreaterThan(0); expect(l.centreX).toBeLessThan(WORLD_SIZE_M);
      expect(l.centreZ).toBeGreaterThan(0); expect(l.centreZ).toBeLessThan(WORLD_SIZE_M);
    }
  });
  it("isRestartSlot is true on even UTC hours only", () => {
    expect(isRestartSlot(at("2026-10-03T20:00:00Z"))).toBe(true);
    expect(isRestartSlot(at("2026-10-03T21:00:00Z"))).toBe(false);
    expect(isRestartSlot(at("2026-10-03T20:00:01Z"))).toBe(false);
  });
});

describe("highWater", () => {
  it("is the peak, and is 0 on no history", () => {
    // ⚠️ 0 on no history is load-bearing, not a convenience: it leaves
    // `max(minPop, 0)` at the floor, which is the right bar on day one
    // and through the first five days. Returning -Infinity (the naive Math.max
    // of an empty list) would leave the floor governing too, but any later
    // arithmetic on the recorded threshold would be poisoned by it.
    expect(highWater([])).toBe(0);
    expect(highWater([1, 1, 1, 1, 1, 1, 1, 1, 1, 10])).toBe(10);
    expect(highWater([5])).toBe(5);
    // ⚠️ One outlier sets the bar for the whole window. This is the accepted
    // cost of the high-water rule (2026-09-21) — see the design's §3.1.
    expect(highWater([2, 2, 11, 3, 2])).toBe(11);
  });
});


describe("the calendar", () => {
  it("starts the ISO week on Monday 00:00 UTC", () => {
    expect(isoWeekStart(at("2026-09-21T19:30:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(isoWeekStart(at("2026-09-20T23:59:59Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
  it("puts the decision 30 minutes before the slot", () => {
    expect(kothDecisionInstantFor(at("2026-10-17T12:00:00Z")).toISOString()).toBe("2026-10-17T11:30:00.000Z");
  });
  it("is the instant the vote closes", () => {
    const slot = at("2026-10-17T12:00:00Z");
    expect(kothDecisionInstantFor(slot).getTime()).toBe(voteClosesAt(slot).getTime());
  });
});
