import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, supplyUploads, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { loadTemplate } from "../src/supplies.js";
import { supplyTick } from "../src/supply-tick.js";

const DB_URL = requireTestDatabaseUrl();
const RAW = JSON.parse(readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"));
const offsets = loadTemplate(RAW);
const now = new Date("2026-09-01T12:00:00Z");

/**
 * A fake Nitrado file server: it stores what was uploaded and reports the
 * size and mtime of what it actually holds. Tests that hand-stub `statFile`
 * independently of `uploadFile` can assert drift that the real pair could
 * never produce, so the fake keeps them honest.
 */
const fakeServer = () => {
  const files = new Map<string, { body: string; modifiedAtMs: number }>();
  let clock = 1_000_000;
  const self = {
    files,
    uploads: [] as { dir: string; name: string; body: string }[],
    statCalls: 0,
    async uploadFile(dir: string, name: string, body: string) {
      self.uploads.push({ dir, name, body });
      clock += 1000;
      files.set(`${dir}/${name}`, { body, modifiedAtMs: clock });
    },
    async statFile(dir: string, name: string) {
      self.statCalls++;
      const f = files.get(`${dir}/${name}`);
      return f ? { size: Buffer.byteLength(f.body, "utf8"), modifiedAtMs: f.modifiedAtMs } : null;
    },
    /** Someone else writes the file: an operator edit, an FTP restore. */
    overwrite(dir: string, name: string, body: string) {
      clock += 1000;
      files.set(`${dir}/${name}`, { body, modifiedAtMs: clock });
    },
    /**
     * A restore that carries the original timestamps across — what `rsync -a`,
     * an FTP client issuing MFMT, or a backup tool that preserves metadata
     * does. The mtime is untouched, so only the size gives it away.
     */
    restorePreservingMtime(dir: string, name: string, body: string) {
      const prev = files.get(`${dir}/${name}`)!;
      files.set(`${dir}/${name}`, { body, modifiedAtMs: prev.modifiedAtMs });
    },
  };
  return self;
};

describe("supplyTick drift detection", () => {
  let db: Database;
  let serverId = 0;

  const seedFaction = async (tag: string) => {
    const [f] = await db.insert(factions).values({
      serverId, name: tag, tag, texture: `Flag_${tag}`,
      poleKey: `${tag}:1:2`, x: "1", y: "2", z: "3",
      status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    return f!;
  };

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table supply_uploads, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await seedFaction("COK");
  });

  const tick = (client: unknown, onDrift?: (d: unknown) => void, at: Date = now) =>
    supplyTick(db, {
      serverId, client: client as never, offsets,
      remoteDir: "/d", fileName: "f.json", now: at, onDrift,
    });

  it("re-uploads when the file on the server was replaced out of band", async () => {
    const srv = fakeServer();
    await tick(srv);
    expect(srv.uploads).toHaveLength(1);

    // An FTP restore drops a different file in place. The database is
    // unchanged, so the content hash still matches and today's tick would
    // short-circuit and leave the factions without supplies.
    srv.overwrite("/d", "f.json", JSON.stringify({ Objects: [] }));

    const r = await tick(srv);
    expect(r.uploaded).toBe(true);
    expect(srv.uploads).toHaveLength(2);
    // What is restored must be the projection, not the foreign file.
    expect(JSON.parse(srv.uploads[1]!.body).Objects).toHaveLength(103);
  });
  it("re-uploads when the file is gone from the server", async () => {
    const srv = fakeServer();
    await tick(srv);
    srv.files.delete("/d/f.json");

    const r = await tick(srv);
    expect(r.uploaded).toBe(true);
    expect(srv.uploads).toHaveLength(2);
  });

  it("detects an edit that preserves the file's size", async () => {
    // ⚠️ Size alone cannot see this. An operator flipping one digit of a
    // coordinate, or a restore of an equal-length file, changes nothing a
    // length check would notice — mtime is the only signal left.
    const srv = fakeServer();
    await tick(srv);
    const original = srv.uploads[0]!.body;
    const sameLength = original.replace("Flag_COK", "Flag_XXX");
    expect(Buffer.byteLength(sameLength)).toBe(Buffer.byteLength(original));
    srv.overwrite("/d", "f.json", sameLength);

    const r = await tick(srv);
    expect(r.uploaded).toBe(true);
  });

  it("detects a restore that preserved the file's mtime", async () => {
    // ⚠️ mtime alone cannot see this. A backup tool that carries timestamps
    // across — rsync -a, an FTP client issuing MFMT — leaves the mtime
    // identical while the contents revert, so size is the only signal left.
    // This is the mirror of the same-size-edit case: neither check subsumes
    // the other, which is why both are compared.
    const srv = fakeServer();
    await tick(srv);
    const before = await srv.statFile("/d", "f.json");
    srv.restorePreservingMtime("/d", "f.json", JSON.stringify({ Objects: [] }));
    expect((await srv.statFile("/d", "f.json"))!.modifiedAtMs).toBe(before!.modifiedAtMs);

    const r = await tick(srv);
    expect(r.uploaded).toBe(true);
    expect(srv.uploads).toHaveLength(2);
  });

  it("reports what it expected and what it found", async () => {
    const srv = fakeServer();
    await tick(srv);
    const drifts: any[] = [];
    srv.overwrite("/d", "f.json", "{}");

    await tick(srv, (d) => drifts.push(d));
    expect(drifts).toHaveLength(1);
    expect(drifts[0].serverId).toBe(serverId);
    expect(drifts[0].found.size).toBe(2);
    expect(drifts[0].expected.size).toBe(Buffer.byteLength(srv.uploads[0]!.body));
  });

  it("stays quiet when the server still holds exactly what we uploaded", async () => {
    // ⚠️ THE regression this whole feature can cause. If the comparison is
    // wrong in the "no drift" direction the tick re-uploads every 60s
    // forever — the always-upload behaviour spec §4.4 rejected.
    const srv = fakeServer();
    await tick(srv);
    const drifts: unknown[] = [];
    for (let i = 0; i < 5; i++) await tick(srv, (d) => drifts.push(d));
    expect(srv.uploads).toHaveLength(1);
    expect(drifts).toEqual([]);
  });

  it("skips the check, and backfills the baseline, when none was captured", async () => {
    // A stat that failed right after an upload leaves nulls. Treating that as
    // drift would re-upload on every tick; the next quiet tick must instead
    // adopt what the server reports.
    const srv = fakeServer();
    await tick(srv);
    await db.update(supplyUploads)
      .set({ remoteSize: null, remoteModifiedAt: null })
      .where(eq(supplyUploads.serverId, serverId));

    const later = new Date("2026-09-01T13:00:00Z");
    const r = await tick(srv, undefined, later);
    expect(r.uploaded).toBe(false);
    expect(srv.uploads).toHaveLength(1);

    // ⚠️ It must ADOPT what it observed, not merely decline to upload. A
    // baseline that is only ever written after an upload leaves detection
    // switched off until the roster happens to change — which, on a server
    // whose factions are stable, can be forever. This is the state every
    // existing row is in the moment the feature ships.
    const [row] = await db.select().from(supplyUploads).where(eq(supplyUploads.serverId, serverId));
    expect(row!.remoteSize).toBe(Buffer.byteLength(srv.uploads[0]!.body, "utf8"));
    expect(row!.remoteModifiedAt).not.toBeNull();
    // ⚠️ and it must NOT restamp uploaded_at: nothing was uploaded on this
    // tick. That column answers "when did we last send this file", which an
    // operator reads to reason about the server's state.
    expect(row!.uploadedAt).toEqual(now);

    // And with a baseline in hand, drift is detected on the very next tick.
    srv.overwrite("/d", "f.json", "{}");
    expect((await tick(srv)).uploaded).toBe(true);
  });

  it("advances the hash even when the baseline stat fails after an upload", async () => {
    // ⚠️ If a failed observation rolled back the hash write, the same bytes
    // would upload on every tick forever.
    const srv = fakeServer();
    let failStat = true;
    const flaky = {
      ...srv,
      uploadFile: srv.uploadFile,
      statFile: async (d: string, n: string) => {
        if (failStat) throw new Error("nitrado list down");
        return srv.statFile(d, n);
      },
    };
    const first = await tick(flaky);
    expect(first.uploaded).toBe(true);
    const [row] = await db.select().from(supplyUploads).where(eq(supplyUploads.serverId, serverId));
    expect(row!.remoteSize).toBeNull();

    failStat = false;
    const second = await tick(flaky);
    expect(second.uploaded).toBe(false);
    expect(srv.uploads).toHaveLength(1);
  });

  it("propagates a stat failure rather than assuming the file is intact", async () => {
    // Being unable to verify is not evidence of health. The sweep's
    // per-server catch reports it; nothing was going to upload on this path
    // anyway, so there is no cost to being loud.
    const srv = fakeServer();
    await tick(srv);
    const broken = { ...srv, uploadFile: srv.uploadFile, statFile: async () => { throw new Error("nitrado list down"); } };
    await expect(tick(broken)).rejects.toThrow(/nitrado list down/);
    expect(srv.uploads).toHaveLength(1);
  });
});
