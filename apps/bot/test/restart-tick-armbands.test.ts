import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { restartTick, RESTART_MESSAGE, type RestartTarget } from "../src/restart-tick.js";
import { renderInitC } from "../src/init-c.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-12T14:00:03Z");
const UID_A = "75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C";
const DIR = "/games/ni1_4/ftproot/dayzxb_missions/dayzOffline.enoch";

/**
 * Records the order of every call, so a test can prove init.c was written
 * BEFORE the restart POST — the whole point of doing it here rather than on a
 * schedule of its own. DayZ compiles init.c at boot; a write afterwards is a
 * write nobody sees for another two hours.
 */
function fakeNitrado(serverCopy: string) {
  const calls: string[] = [];
  const uploads: { dir: string; name: string; content: string }[] = [];
  const t = {
    status: vi.fn(async () => { calls.push("status"); return "started"; }),
    restart: vi.fn(async () => { calls.push("restart"); }),
    missionDir: vi.fn(async () => DIR),
    missionDbDir: vi.fn(async () => `${DIR}/db`),
    downloadFile: vi.fn(async () => { calls.push("download"); return serverCopy; }),
    uploadFile: vi.fn(async (dir: string, name: string, content: string) => {
      calls.push(`upload:${name}`);
      uploads.push({ dir, name, content });
    }),
  };
  return { target: t as unknown as RestartTarget, t, calls, uploads };
}

describe("restartTick — clan armbands", () => {
  let db: Database; let serverId = 0;
  const lastError = new Map<number, string>();

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table server_restarts, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 4242, active: true,
    }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "BEAR", tag: "BEAR", texture: "Flag_Bear",
      status: "active", leaderDiscordId: "d1", createdAt: NOW,
    }).returning();
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId, dayzId: UID_A, discordId: "disc-a",
      role: "leader", joinedAt: NOW, status: "full",
    });
    lastError.clear();
  });

  it("writes init.c before the restart POST", async () => {
    const f = fakeNitrado("stale init.c");
    const r = await restartTick(db, () => f.target, { now: NOW, lastError, armbands: true });

    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 0 });
    expect(f.calls.indexOf("upload:init.c")).toBeGreaterThan(-1);
    expect(f.calls.indexOf("upload:init.c")).toBeLessThan(f.calls.indexOf("restart"));
    expect(f.t.restart).toHaveBeenCalledWith(RESTART_MESSAGE);
    expect(f.uploads[0]!.dir).toBe(DIR);
    expect(f.uploads[0]!.content).toContain(`if (uid == "${UID_A}") return "Armband_Bear";`);
  });

  /**
   * ⚠️ The roster changes far less often than the restart cadence. Re-uploading
   * an identical file every two hours is a write to the mission tree for no
   * reason, and it makes the one that MATTERS invisible in the logs.
   */
  it("does not re-upload when the server's copy already matches", async () => {
    const wanted = renderInitC([{ dayzId: UID_A, armband: "Armband_Bear" }]);
    const f = fakeNitrado(wanted);
    await restartTick(db, () => f.target, { now: NOW, lastError, armbands: true });

    expect(f.t.downloadFile).toHaveBeenCalledTimes(1); // it still checks
    expect(f.t.uploadFile).not.toHaveBeenCalled();
    expect(f.t.restart).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Same rule as the truck wipe: players rely on the two-hour cadence, and
   * the next slot recomputes the file anyway. An armband failure must never
   * cost the restart.
   */
  it("still restarts when writing init.c fails", async () => {
    const f = fakeNitrado("stale init.c");
    f.t.uploadFile.mockRejectedValueOnce(new Error("nitrado 500"));

    const r = await restartTick(db, () => f.target, { now: NOW, lastError, armbands: true });

    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 0 });
    expect(f.t.restart).toHaveBeenCalledWith(RESTART_MESSAGE);
  });

  it("touches init.c not at all when armbands are off", async () => {
    const f = fakeNitrado("stale init.c");
    await restartTick(db, () => f.target, { now: NOW, lastError });

    expect(f.t.missionDir).not.toHaveBeenCalled();
    expect(f.t.downloadFile).not.toHaveBeenCalled();
    expect(f.t.uploadFile).not.toHaveBeenCalled();
    expect(f.t.restart).toHaveBeenCalledTimes(1);
  });
});
