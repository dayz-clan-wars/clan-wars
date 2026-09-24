import { describe, it, expect } from "vitest";
import {
  kothWanted, inKothZone, kothStandings, kothWinner, restoredPresets, isRestartSlot,
  KOTH_LOCATIONS, kothLocation, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, KOTH_ZONE_RADIUS_M,
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
  it("has the 31 towns and 44 presets, all flat in ./custom/ with the prefix", () => {
    expect(KOTH_LOCATIONS).toHaveLength(31);
    expect(kothLocation("lembork")?.name).toBe("Lembork");
    expect(kothLocation("narnia")).toBeNull();
    expect(KOTH_PRESET_FILES).toHaveLength(44);
    for (const p of KOTH_PRESET_FILES) expect(p).toMatch(/^\.\/custom\/koth-[a-z0-9-]+\.json$/);
  });
  it("isRestartSlot is true on even UTC hours only", () => {
    expect(isRestartSlot(at("2026-10-03T20:00:00Z"))).toBe(true);
    expect(isRestartSlot(at("2026-10-03T21:00:00Z"))).toBe(false);
    expect(isRestartSlot(at("2026-10-03T20:00:01Z"))).toBe(false);
  });
});
