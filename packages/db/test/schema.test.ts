import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, servers, poles, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("schema", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table poles, events, raw_lines, adm_files, servers restart identity cascade`);
  });

  it("creates a server row", async () => {
    const [row] = await db.insert(servers).values({ name: "Livonia 10x", map: "livonia" }).returning();
    expect(row?.id).toBeGreaterThan(0);
  });

  it("enforces one pole key per (server, map)", async () => {
    const [srv] = await db.insert(servers).values({ name: "S2", map: "chernarus" }).returning();
    const base = {
      serverId: srv!.id, map: "chernarus",
      poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    };
    await db.insert(poles).values(base);
    await expect(db.insert(poles).values(base)).rejects.toThrow();
  });

  it("allows the same pole key on a different server", async () => {
    const [srv] = await db.insert(servers).values({ name: "S3", map: "chernarus" }).returning();
    const row = await db.insert(poles).values({
      serverId: srv!.id, map: "chernarus",
      poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    }).returning();
    expect(row).toHaveLength(1);
  });
});
