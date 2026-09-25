import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb } from "../fixture.js";
import { MemoryScreeningStore, PgScreeningStore, ReadThroughScreeningStore, type ScreeningStore } from "../../src/screening/store.js";

// ⚠️ One client for the file; a client per test leaks its pool.
let pg: Database | undefined;

describe.each([
  ["memory", async () => new MemoryScreeningStore() as ScreeningStore],
  ["postgres", async () => {
    pg ??= await openDb();
    await pg.execute(sql`truncate table show_text_screening`);
    return new PgScreeningStore(pg) as ScreeningStore;
  }],
])("%s screening store", (_name, make) => {
  let store: ScreeningStore;
  beforeEach(async () => { store = await make(); });

  it("round-trips verdicts and returns only what it has", async () => {
    await store.put("GoldSkull588", { verdict: "allow", source: "llm", reason: null });
    const got = await store.get(["GoldSkull588", "unknown"]);
    expect([...got]).toEqual([["GoldSkull588", { verdict: "allow", source: "llm", reason: null }]]);
  });

  it("⚠️ an operator verdict is never overwritten by an automatic one", async () => {
    await store.put("Spicy", { verdict: "allow", source: "operator", reason: "false positive" });
    await store.put("Spicy", { verdict: "block", source: "llm", reason: "hate" });
    expect((await store.get(["Spicy"])).get("Spicy")).toEqual({ verdict: "allow", source: "operator", reason: "false positive" });
  });

  it("an operator verdict replaces an automatic one", async () => {
    await store.put("x", { verdict: "block", source: "llm", reason: "r" });
    await store.put("x", { verdict: "allow", source: "operator", reason: null });
    expect((await store.get(["x"])).get("x")!.source).toBe("operator");
  });
});

describe("read-through screening store (a dry run's view of the real verdicts)", () => {
  it("reads from the backing store, never writes to it, and its own verdicts win", async () => {
    const backing = new MemoryScreeningStore();
    await backing.put("Heil", { verdict: "allow", source: "operator", reason: "a real player" });
    await backing.put("Spicy", { verdict: "allow", source: "llm", reason: null });
    const put = vi.spyOn(backing, "put");
    const store = new ReadThroughScreeningStore(backing);

    await store.put("Spicy", { verdict: "block", source: "llm", reason: "r" });
    await store.put("New", { verdict: "allow", source: "llm", reason: null });
    expect(put).not.toHaveBeenCalled();

    const got = await store.get(["Heil", "Spicy", "New", "unknown"]);
    expect(Object.fromEntries(got)).toEqual({
      Heil: { verdict: "allow", source: "operator", reason: "a real player" },
      Spicy: { verdict: "block", source: "llm", reason: "r" },
      New: { verdict: "allow", source: "llm", reason: null },
    });
    expect((await backing.get(["Spicy", "New"])).get("Spicy")).toEqual({ verdict: "allow", source: "llm", reason: null });
    expect((await backing.get(["New"])).has("New")).toBe(false);
  });
});
