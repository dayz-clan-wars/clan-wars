import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, rawLines, events, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const HOUR = 3_600_000;

// Real ADM files end with a newline; the live-file partial-line guard keys off
// exactly that, so the fixtures must have one.
const body = (header: string, ...rest: string[]) => [`AdminLog started on ${header}`, ...rest].join("\n") + "\n";
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
    const r = await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15, failures: new Map() });
    expect(r.filesProcessed).toBe(2);
    expect(r.offsetMs).toBe(7 * HOUR);
    const [s] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(s?.clockOffsetMs).toBe(7 * HOUR);
  });

  it("marks older files complete but never the newest", async () => {
    // The newest file is still being written. Marking it complete would make
    // the next tick skip every line it is about to gain.
    await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15, failures: new Map() });
    const rows = await db.select().from(admFiles).orderBy(admFiles.id);
    expect(rows.map((f) => f.complete)).toEqual([true, false]);
  });

  it("skips a completed older file on the next tick", async () => {
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 15, failures: new Map() });
    client.downloads.length = 0;
    await ingestTick(db, { serverId, client, backfillBudget: 15, failures: new Map() });
    // Only the live file is re-downloaded.
    expect(client.downloads).toEqual(["/b.ADM"]);
  });

  it("stops backfilling at the budget", async () => {
    const client = twoFiles();
    const r = await ingestTick(db, { serverId, client, backfillBudget: 0, failures: new Map() });
    // No budget for the older file, so nothing is downloaded at all.
    expect(r.filesProcessed).toBe(0);
    expect(client.downloads).toEqual([]);
  });

  it("does not advance to the live file while an older file is pending", async () => {
    // ⚠️ Ordering is load-bearing: the live file's timestamps depend on every
    // file before it. Reaching it early would ingest it against an
    // incomplete history.
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 0, failures: new Map() });
    expect(client.downloads).not.toContain("/b.ADM");
  });

  it("keeps the stored offset when no file carries usable metadata", async () => {
    // ⚠️ A zero here would silently shift every timestamp by hours while
    // every count-based check stayed green.
    const client = fake([
      { name: "weird.ADM", path: "/w.ADM", localMs: NaN, modMs: 0, text: FILE_A },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15, failures: new Map() });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("excludes a file whose mtime is missing from the derivation", async () => {
    const client = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: 0, text: FILE_A },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15, failures: new Map() });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("continues past a file that fails to download", async () => {
    const client = twoFiles();
    const original = client.downloadFile.bind(client);
    client.downloadFile = async (p: string) => { if (p === "/a.ADM") throw new Error("boom"); return original(p); };
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15, failures: new Map() });
    // The failed older file leaves the tick incomplete, so the live file waits.
    expect(r.filesProcessed).toBe(0);
    // ⚠️ The load-bearing half: the live file must NOT have been fetched. A
    // bare `filesProcessed === 0` is also satisfied by a tick that downloaded
    // it and failed for some other reason.
    expect(client.downloads).not.toContain("/b.ADM");
  });

  it("does nothing when the server has no files", async () => {
    const r = await ingestTick(db, { serverId, client: fake([]), backfillBudget: 15, failures: new Map() });
    expect(r).toMatchObject({ filesProcessed: 0, eventsAppended: 0 });
  });

  it("retains the tightest offset ever observed instead of overwriting it", async () => {
    // ⚠️ Every candidate is `trueOffset + writeLag`, so a tick that happens to
    // list only long-lag files derives a LOOSER (larger) offset. Overwriting
    // the stored value with it would stamp the same ADM file's later lines
    // hours away from its earlier ones, with nothing able to correct it.
    await db.update(servers).set({ clockOffsetMs: 9 * HOUR }).where(eq(servers.id, serverId));

    const tight = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: day(22) + 7 * HOUR, text: FILE_A },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
    ]);
    const t1 = await ingestTick(db, { serverId, client: tight, backfillBudget: 15, failures: new Map() });
    expect(t1.offsetMs).toBe(7 * HOUR);

    // Tick 2 sees only long write-lags: every candidate is now 9h.
    const loose = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: day(22) + 9 * HOUR, text: FILE_A },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 9 * HOUR, text: FILE_B },
    ]);
    const t2 = await ingestTick(db, { serverId, client: loose, backfillBudget: 15, failures: new Map() });
    expect(t2.offsetMs).toBe(7 * HOUR);
    const [s] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(s?.clockOffsetMs).toBe(7 * HOUR);
  });

  /** The raw lines stored for one ADM filename, in order. */
  const storedLines = async (filename: string) => {
    const [f] = await db.select().from(admFiles).where(eq(admFiles.filename, filename));
    if (!f) return [];
    const rows = await db.select().from(rawLines).where(eq(rawLines.admFileId, f.id)).orderBy(rawLines.lineIndex);
    return rows.map((r) => r.content);
  };

  it("quarantines a file that never downloads so the live file can proceed", async () => {
    // ⚠️ Without the bounded counter this file blocks the live file forever:
    // it is re-listed every tick, fails every tick, and `allCaughtUp = false`
    // means the live file is never downloaded again for the process lifetime.
    const client = twoFiles();
    const original = client.downloadFile.bind(client);
    client.downloadFile = async (p: string) => { if (p === "/a.ADM") throw new Error("boom"); return original(p); };
    const failures = new Map<string, number>();

    for (let i = 0; i < 4; i++) {
      await ingestTick(db, { serverId, client, backfillBudget: 15, failures });
    }

    expect(client.downloads).toContain("/b.ADM");
    expect(await storedLines("DayZServer_X1_x64_2026-07-23_01-00-00.ADM")).toEqual(FILE_B.trimEnd().split("\n"));
  });

  it("quarantines a file with no boot header so the live file can proceed", async () => {
    const client = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: day(22) + 7 * HOUR, text: "01:30:00 | headerless" },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
    ]);
    const failures = new Map<string, number>();

    for (let i = 0; i < 4; i++) {
      await ingestTick(db, { serverId, client, backfillBudget: 15, failures });
    }

    expect(client.downloads).toContain("/b.ADM");
    expect(await storedLines("DayZServer_X1_x64_2026-07-23_01-00-00.ADM")).toEqual(FILE_B.trimEnd().split("\n"));
  });

  it("stops re-downloading a quarantined file", async () => {
    const client = twoFiles();
    const original = client.downloadFile.bind(client);
    let attempts = 0;
    client.downloadFile = async (p: string) => {
      if (p === "/a.ADM") { attempts++; throw new Error("boom"); }
      return original(p);
    };
    const failures = new Map<string, number>();

    for (let i = 0; i < 6; i++) {
      await ingestTick(db, { serverId, client, backfillBudget: 15, failures });
    }
    // Three attempts is the whole cost for the process lifetime; every later
    // tick skips the file before spending a download.
    expect(attempts).toBe(3);
  });

  it("does not store the live file's dangling final line until it is complete", async () => {
    // ⚠️ The live file is downloaded while the server is appending to it, so
    // the last byte can land mid-line. Storing that fragment advances the
    // cursor past it, and the complete version can never be written
    // afterwards — the line, and any raid event it carried, is lost for good.
    const HEADER = "AdminLog started on 2026-07-23 at 01:00:00";
    const FULL = `01:30:00 | Player "B" (id=${ID}) is connected`;
    const name = "DayZServer_X1_x64_2026-07-23_01-00-00.ADM";
    const live = (text: string) => fake([
      { name, path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text },
    ]);

    // Tick 1 sees the line half-written, with no trailing newline.
    await ingestTick(db, {
      serverId, client: live(`${HEADER}\n01:30:00 | Player "B" (id=${ID}) is conn`),
      backfillBudget: 15, failures: new Map(),
    });
    expect(await storedLines(name)).toEqual([HEADER]);

    // Tick 2 sees the same line whole.
    await ingestTick(db, {
      serverId, client: live(`${HEADER}\n${FULL}\n`), backfillBudget: 15, failures: new Map(),
    });
    expect(await storedLines(name)).toEqual([HEADER, FULL]);
  });
});
