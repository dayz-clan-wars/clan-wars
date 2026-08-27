import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { appendEvent } from "../src/append.js";
import { readEventBatch } from "../src/cursor.js";

const URL = requireTestDatabaseUrl();

describe("readEventBatch", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: new Date() }).returning();
    admFileId = f!.id;
    for (let i = 0; i < 5; i++) {
      await appendEvent(db, {
        serverId, admFileId, lineIndex: i, subIndex: 0,
        type: "emote.performed", occurredAt: new Date(), payload: { i },
      });
    }
  });

  it("returns events after the cursor in id order", async () => {
    const batch = await readEventBatch(db, 0, 10);
    expect(batch).toHaveLength(5);
    expect(batch.map((r) => r.id)).toEqual([...batch.map((r) => r.id)].sort((a, b) => a - b));
  });

  it("excludes the cursor event itself", async () => {
    const all = await readEventBatch(db, 0, 10);
    const batch = await readEventBatch(db, all[0]!.id, 10);
    expect(batch).toHaveLength(4);
  });

  it("respects the limit", async () => {
    expect(await readEventBatch(db, 0, 2)).toHaveLength(2);
  });

  it("returns an empty array past the end", async () => {
    const all = await readEventBatch(db, 0, 10);
    expect(await readEventBatch(db, all[4]!.id, 10)).toHaveLength(0);
  });
});
