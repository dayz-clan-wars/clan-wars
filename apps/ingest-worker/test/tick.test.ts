import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const HOUR = 3_600_000;

const body = (header: string, ...rest: string[]) => [`AdminLog started on ${header}`, ...rest].join("\n");
const FILE_A = body("2026-07-22 at 01:00:00", `01:30:00 | Player "A" (id=${ID}) is connected`);
const FILE_B = body("2026-07-23 at 01:00:00", `01:30:00 | Player "B" (id=${ID}) is connected`);

/** A fake Nitrado, so the tick is testable without HTTP. */
function fake(files: { name: string; path: string; localMs: number; modMs: number; text: string }[]): NitradoLike & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    listAdmFiles: async () => files.map((f) => ({
      path: f.path, name: f.name, localTimestampMs: f.localMs, modifiedAtMs: f.modMs,
    })),
    downloadFile: async (path: string) => {
      downloads.push(path);
      const f = files.find((x) => x.path === path);
      if (!f) throw new Error(`no such file ${path}`);
      return f.text;
    },
  };
}

const day = (d: number) => Date.UTC(2026, 6, d, 1, 0, 0);

describe("ingestTick", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "S", map: "livonia", clockOffsetMs: 7 * HOUR, nitradoServiceId: 1234,
    }).returning();
    serverId = s!.id;
  });

  const twoFiles = () => fake([
    { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: day(22) + 7 * HOUR, text: FILE_A },
    { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
  ]);

  it("ingests every file and records the derived offset", async () => {
    const r = await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15 });
    expect(r.filesProcessed).toBe(2);
    expect(r.offsetMs).toBe(7 * HOUR);
    const [s] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(s?.clockOffsetMs).toBe(7 * HOUR);
  });

  it("marks older files complete but never the newest", async () => {
    // The newest file is still being written. Marking it complete would make
    // the next tick skip every line it is about to gain.
    await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15 });
    const rows = await db.select().from(admFiles).orderBy(admFiles.id);
    expect(rows.map((f) => f.complete)).toEqual([true, false]);
  });

  it("skips a completed older file on the next tick", async () => {
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 15 });
    client.downloads.length = 0;
    await ingestTick(db, { serverId, client, backfillBudget: 15 });
    // Only the live file is re-downloaded.
    expect(client.downloads).toEqual(["/b.ADM"]);
  });

  it("stops backfilling at the budget", async () => {
    const client = twoFiles();
    const r = await ingestTick(db, { serverId, client, backfillBudget: 0 });
    // No budget for the older file, so nothing is downloaded at all.
    expect(r.filesProcessed).toBe(0);
    expect(client.downloads).toEqual([]);
  });

  it("does not advance to the live file while an older file is pending", async () => {
    // ⚠️ Ordering is load-bearing: the live file's timestamps depend on every
    // file before it. Reaching it early would ingest it against an
    // incomplete history.
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 0 });
    expect(client.downloads).not.toContain("/b.ADM");
  });

  it("keeps the stored offset when no file carries usable metadata", async () => {
    // ⚠️ A zero here would silently shift every timestamp by hours while
    // every count-based check stayed green.
    const client = fake([
      { name: "weird.ADM", path: "/w.ADM", localMs: NaN, modMs: 0, text: FILE_A },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("excludes a file whose mtime is missing from the derivation", async () => {
    const client = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: 0, text: FILE_A },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("continues past a file that fails to download", async () => {
    const client = twoFiles();
    const original = client.downloadFile.bind(client);
    client.downloadFile = async (p: string) => { if (p === "/a.ADM") throw new Error("boom"); return original(p); };
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    // The failed older file leaves the tick incomplete, so the live file waits.
    expect(r.filesProcessed).toBe(0);
  });

  it("does nothing when the server has no files", async () => {
    const r = await ingestTick(db, { serverId, client: fake([]), backfillBudget: 15 });
    expect(r).toMatchObject({ filesProcessed: 0, eventsAppended: 0 });
  });
});
