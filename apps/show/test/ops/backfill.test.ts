import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, type Fx } from "../fixture.js";
import { backfillPronunciations, knownNames } from "../../src/ops/backfill.js";
import { MemoryPronunciationStore } from "../../src/engine/audio/pronunciationStore.js";

describe("pronunciation backfill", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("knows every gamertag, clan name and tag once", async () => {
    await fx.clan({ tag: "SNA", name: "Snakes" });
    await fx.player("a", "GoldSkull588");
    await fx.player("b", "SNA");
    expect(await knownNames(db)).toEqual(["GoldSkull588", "SNA", "Snakes"]);
  });

  it("never sends a blocked name to the pronouncer, skips overrides and cached rows", async () => {
    const store = new MemoryPronunciationStore();
    await store.insertMissing([{ text: "Cached1", spoken: "cached one", source: "llm" }]);
    const asked: string[][] = [];
    const r = await backfillPronunciations({
      names: ["Bad88", "Cached1", "Over", "New1", "New2"],
      screen: async (t) => new Map(t.map((x) => [x, { verdict: x === "Bad88" ? "block" : "allow", source: "llm", reason: null }] as const)),
      store, overrides: { Over: "oh ver" }, dryRun: false,
      pronounce: async (names) => { asked.push(names); await store.insertMissing(names.map((n) => ({ text: n, spoken: n.toLowerCase(), source: "llm" }))); },
    });
    expect(asked).toEqual([["New1", "New2"]]);
    expect(r).toMatchObject({ total: 5, blocked: 1, overridden: 1, cached: 1, toGenerate: ["New1", "New2"], generated: 2 });
  });

  it("dry run screens and counts but pronounces nothing", async () => {
    const store = new MemoryPronunciationStore();
    let called = false;
    const r = await backfillPronunciations({
      names: ["New1"], screen: async (t) => new Map(t.map((x) => [x, { verdict: "allow", source: "llm", reason: null }] as const)),
      store, overrides: {}, dryRun: true, pronounce: async () => { called = true; },
    });
    expect(called).toBe(false);
    expect(r).toMatchObject({ toGenerate: ["New1"], generated: 0 });
  });

  it("chunks the screen and the pronouncer at 50", async () => {
    const names = Array.from({ length: 120 }, (_, i) => `P${i}`);
    const screened: number[] = [];
    const asked: number[] = [];
    const store = new MemoryPronunciationStore();
    await backfillPronunciations({
      names, store, overrides: {}, dryRun: false,
      screen: async (t) => { screened.push(t.length); return new Map(t.map((x) => [x, { verdict: "allow", source: "llm", reason: null }] as const)); },
      pronounce: async (n) => { asked.push(n.length); },
    });
    expect(screened).toEqual([50, 50, 20]);
    expect(asked).toEqual([50, 50, 20]);
  });
});
