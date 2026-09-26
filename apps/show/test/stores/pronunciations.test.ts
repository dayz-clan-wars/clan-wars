import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb } from "../fixture.js";
import { MemoryPronunciationStore } from "../../src/engine/audio/pronunciationStore.js";
import { PgPronunciationStore, ReadThroughPronunciationStore } from "../../src/stores/pronunciations.js";

// ⚠️ One client for the file; a client per test leaks its pool.
let pg: Database | undefined;

async function freshPgStore() {
  pg ??= await openDb();
  await pg.execute(sql`truncate table show_pronunciations`);
  return new PgPronunciationStore(pg);
}

describe("PgPronunciationStore", () => {
  it("round-trips via insertMissing then get", async () => {
    const store = await freshPgStore();
    await store.insertMissing([{ text: "GoldSkull588", spoken: "Gold Skull", source: "llm" }]);
    expect(await store.get(["GoldSkull588", "unknown"])).toEqual({ GoldSkull588: "Gold Skull" });
  });

  it("a second insertMissing for the same text with a different spoken form leaves the first", async () => {
    const store = await freshPgStore();
    await store.insertMissing([{ text: "Tag", spoken: "First", source: "llm" }]);
    await store.insertMissing([{ text: "Tag", spoken: "Second", source: "override" }]);
    expect(await store.get(["Tag"])).toEqual({ Tag: "First" });
  });

  it("get([]) returns {} without querying", async () => {
    const store = await freshPgStore();
    const spy = vi.spyOn(pg!, "select");
    expect(await store.get([])).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("ReadThroughPronunciationStore (a dry run's view of the real rows)", () => {
  it("reads a Pg row and writes only to the memory store", async () => {
    const read = await freshPgStore();
    await read.insertMissing([{ text: "Heil", spoken: "Hile", source: "llm" }]);
    const write = new MemoryPronunciationStore();
    const writeSpy = vi.spyOn(write, "insertMissing");
    const store = new ReadThroughPronunciationStore(read, write);

    await store.insertMissing([{ text: "New", spoken: "Noo", source: "llm" }]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await read.get(["New"])).toEqual({}); // never written to the Pg backing

    const got = await store.get(["Heil", "New", "unknown"]);
    expect(got).toEqual({ Heil: "Hile", New: "Noo" });
  });
});
