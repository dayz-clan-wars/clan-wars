import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { liveServersDb } from "../src/servers";

const URL = requireTestDatabaseUrl();
const seen = new Date("2026-09-11T12:00:00Z");

/**
 * The site's server strip: the in-game name of each server being played,
 * as Nitrado last reported it. Nothing about the viewer, nothing about a
 * clan — the one read on the site that is the same for everyone.
 */
describe("liveServersDb", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table servers restart identity cascade`);
    });
  });

  const add = (o: Record<string, unknown>) => db.insert(servers).values({
    name: `S${Math.random()}`, map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, hostname: "Clan Wars Livonia", hostnameSeenAt: seen, ...o,
  });

  it("lists active servers with a confirmed hostname, oldest registration first", async () => {
    await add({ hostname: "Second", nitradoServiceId: 2 });
    await add({ hostname: "First | Xbox", map: "chernarus", nitradoServiceId: 3 });
    expect(await liveServersDb(db)).toEqual([
      { hostname: "Second", map: "livonia", seenAt: seen },
      { hostname: "First | Xbox", map: "chernarus", seenAt: seen },
    ]);
  });

  it("leaves out retired servers, replay rows, and servers the worker has not read yet", async () => {
    await add({ active: false });
    await add({ nitradoServiceId: null });
    await add({ hostname: null, hostnameSeenAt: null });
    expect(await liveServersDb(db)).toEqual([]);
  });
});
