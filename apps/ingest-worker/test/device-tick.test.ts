import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, playerDevices, events, admFiles, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { deviceTick } from "../src/device-tick.js";

const URL = requireTestDatabaseUrl();

const RPT = [
  `17:03:01.672 [StateMachine]: Player PCGuy (dpnid 111 uid AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Entering AuthPlayerLoginState`,
  `17:03:03.313  LOGINQUEUE   : Player 111 updated with device type 'desktop'`,
  `17:03:04.000 [StateMachine]: Player BoxGuy (dpnid 222 uid BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB) Entering AuthPlayerLoginState`,
  `17:03:05.000  LOGINQUEUE   : Player 222 updated with device type 'console'`,
].join("\n");

describe("deviceTick", () => {
  let db: Database;
  let admFileId: number;
  const now = new Date("2026-09-18T12:00:00Z");
  const client = (rpt = RPT, path: string | null = "/p/live.RPT") => ({
    newestRptPath: async () => path,
    downloadFile: async () => rpt,
  });

  /**
   * ⚠️ `events.adm_file_id` is NOT NULL and references `adm_files`, so a
   * connect cannot be seeded without a file row. `line_index` (not
   * `line_number`) plus `sub_index` form the idempotency key, so each seeded
   * event needs its own line index.
   */
  let line = 0;
  const connected = async (dayzId: string, at: Date) => {
    await db.insert(events).values({
      serverId: 1, admFileId: admFileId, lineIndex: line++, type: "player.connected",
      occurredAt: at, payload: { dayzId },
    } as never);
  };

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate player_devices, events, adm_files, servers restart identity cascade`);
    // `truncate ... restart identity` makes this the id-1 row every test assumes.
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true });
    const [f] = await db.insert(admFiles)
      .values({ serverId: 1, filename: "t.ADM", bootAt: new Date("2026-09-18T00:00:00Z") })
      .returning();
    admFileId = f!.id;
    line = 0;
  });

  it("does nothing when every recently-connected account already has a device", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    await db.insert(playerDevices).values({ dayzId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", device: "desktop", gamertag: "PCGuy" });
    expect(await deviceTick(db, { serverId: 1, client: client(), now })).toEqual({ fetched: false, upserted: 0 });
  });

  it("does nothing when nobody has connected recently", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60 * 60_000));
    expect(await deviceTick(db, { serverId: 1, client: client(), now })).toEqual({ fetched: false, upserted: 0 });
  });

  /** One fetch, every sighting in the file — the others would each cost another fetch later. */
  it("fetches once for an unknown account and records EVERY sighting in the file", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    const r = await deviceTick(db, { serverId: 1, client: client(), now });
    expect(r).toEqual({ fetched: true, upserted: 2 });
    const rows = await db.select().from(playerDevices);
    expect(rows.map((x) => [x.dayzId, x.device]).sort()).toEqual([
      ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "desktop"],
      ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "console"],
    ]);
  });

  it("keeps first_seen_at and advances last_seen_at on a repeat sighting", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    await deviceTick(db, { serverId: 1, client: client(), now });
    const [before] = await db.select().from(playerDevices).where(sql`dayz_id = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    await db.execute(sql`delete from player_devices where dayz_id = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'`);
    const later = new Date(now.getTime() + 600_000);
    await connected("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", later);
    await deviceTick(db, { serverId: 1, client: client(), now: later });
    const [after] = await db.select().from(playerDevices).where(sql`dayz_id = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    expect(after!.firstSeenAt).toEqual(before!.firstSeenAt);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
  });

  /** ⚠️ Fails closed: no RPT, no rows, no error. */
  it("records nothing when there is no RPT to read", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    expect(await deviceTick(db, { serverId: 1, client: client(RPT, null), now })).toEqual({ fetched: false, upserted: 0 });
    expect(await db.select().from(playerDevices)).toEqual([]);
  });
});
