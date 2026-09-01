import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "../src/index.js";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-08-31T12:00:00Z");

describe("live ingest schema", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table adm_files, servers restart identity cascade`);
  });

  const server = (o: Record<string, unknown> = {}) => db.insert(servers).values({
    name: "S", map: "sakhal", clockOffsetMs: 25_200_000, nitradoServiceId: 1234, ...o,
  }).returning();

  it("stores a Nitrado service id", async () => {
    const [s] = await server();
    expect(s?.nitradoServiceId).toBe(1234);
  });

  it("lets a server be created without a service id", async () => {
    // The historical-export replay creates server rows with no Nitrado
    // service behind them — there is nothing to fetch for them, and
    // inventing an id would be fabricated data.
    const [s] = await server({ nitradoServiceId: undefined });
    expect(s?.nitradoServiceId).toBeNull();
  });

  it("defaults a server to active", async () => {
    // The sweep runs over active servers. A newly registered server should
    // start ingesting without a second call to turn it on.
    const [s] = await server();
    expect(s?.active).toBe(true);
  });

  it("lets a server be deactivated", async () => {
    const [s] = await server();
    await db.update(servers).set({ active: false }).where(eq(servers.id, s!.id));
    const [after] = await db.select().from(servers).where(eq(servers.id, s!.id));
    expect(after?.active).toBe(false);
  });

  it("stores the Nitrado download path alongside the filename", async () => {
    // filename stays the identity — its unique index is (server_id, filename) —
    // and path is only how the bytes are fetched.
    const [s] = await server();
    const [f] = await db.insert(admFiles).values({
      serverId: s!.id, filename: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM",
      path: "/games/ni1234/noftp/dayzxb/config/DayZServer_X1_x64_2026-07-22_01-00-00.ADM",
      bootAt: now,
    }).returning();
    expect(f?.path).toContain("/config/");
    expect(f?.linesIngested).toBe(0);
    expect(f?.complete).toBe(false);
  });

  it("still refuses two files with one filename on one server", async () => {
    const [s] = await server();
    const row = { serverId: s!.id, filename: "a.ADM", path: "/a.ADM", bootAt: now };
    await db.insert(admFiles).values(row);
    await expect(db.insert(admFiles).values(row)).rejects.toThrow(/adm_files_server_filename_uniq/);
  });
});
