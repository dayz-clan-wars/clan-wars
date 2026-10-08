import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, serverRestarts, servers, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restartTick, restartMessage, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-21T20:00:00Z");
const GAMEPLAY = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");
const exit = (customString: string, pos: number[], yaw: number) =>
  ({ name: "Land_Underground_Stairs_Exit", pos, ypr: [yaw, 0, 0], scale: 1, enableCEPersistency: 0, customString });
const ROOMS = JSON.stringify({ Objects: [exit("NWAF", [4765.7, 338.8, 10384.0], 149)] });
const TEMPLATE = JSON.stringify({ Objects: [exit("", [2782.4, 25.9, 1195.4], 0),
  { name: "Land_Underground_Panel", pos: [2785.8, 28.2, 1196.1], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] });

/** A mission on a fake Nitrado. Every path not given 404s. */
function host(gameplay = GAMEPLAY, over: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>(Object.entries({
    "/mission/cfggameplay.json": gameplay,
    "/mission/custom/keycard-rooms.json": ROOMS,
    "/mission/custom/keycard-bunker-boom.json": TEMPLATE,
    "/mission/custom/keycard-bunker-guns.json": TEMPLATE,
  }));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) files.delete(k); else files.set(k, v); }
  const restart = vi.fn(async () => {});
  const uploads: string[] = [];
  const target = {
    status: vi.fn(async () => "started"), restart,
    missionDbDir: vi.fn(async () => "/db"), missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async (p: string) => { const v = files.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v; }),
    uploadFile: vi.fn(async (d: string, n: string, b: string) => { uploads.push(`${d}/${n}`); files.set(`${d}/${n}`, b); }),
  } as unknown as RestartTarget;
  return {
    target, restart, uploads, file: (p: string) => files.get(p),
    spawners: () => JSON.parse(files.get("/mission/cfggameplay.json")!).WorldsData.objectSpawnersArr as string[],
  };
}

describe("the bunker at the slot", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, server_restarts, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "chernarusplus", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const decide = (over: Record<string, unknown> = {}) => db.insert(airdropEvents).values({
    serverId, slotAt: SLOT, location: "nwaf", colour: null, kind: "boom", decidedAt: at("2026-09-21T19:30:00Z"),
    popAtDecision: 6, threshold: "5", state: "announced", announcedAt: at("2026-09-21T19:30:01Z"), ...over,
  });
  const state = async () => (await db.select().from(airdropEvents).where(eq(airdropEvents.slotAt, SLOT)))[0];

  it("stages the bunker file, then registers it, and marks the row live", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/bunker-online.json");
    // ⚠️ The file first: a spawner registered before its file exists spawns nothing.
    expect(h.uploads.indexOf("/mission/custom/bunker-online.json")).toBeLessThan(h.uploads.indexOf("/mission/cfggameplay.json"));
    expect(JSON.parse(h.file("/mission/custom/bunker-online.json")!).Objects[0].name).toBe("Land_Underground_Panel");
    expect((await state())!.state).toBe("live");
  });

  it("takes it away at the next slot and marks the row ended", async () => {
    await decide({ state: "live" });
    const h = host(GAMEPLAY.replace('"./custom/admin-castle.json"', '"./custom/admin-castle.json",\n\t\t\t"./custom/bunker-online.json"'));
    await restartTick(db, () => h.target, { now: at("2026-09-21T22:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect((await state())!.state).toBe("ended");
  });

  it("never enables a row whose announcement has not posted", async () => {
    await decide({ announcedAt: null });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect(h.uploads).not.toContain("/mission/custom/bunker-online.json");
  });

  // ⚠️ Review focus 3: the file vanished mid-session; the re-converge puts it back first.
  it("puts a live bunker's file and entry back if something removed them during its session", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.file("/mission/custom/bunker-online.json")).toBeDefined();
    expect(h.spawners()).toContain("./custom/bunker-online.json");
  });

  it("names the room in the in-game restart warning, and only for that slot", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage("NWAF"));
    expect(restartMessage("NWAF")).toContain("Bunker online at NWAF next session.");
    expect(restartMessage(null)).toBe("Scheduled restart");
  });

  // ⚠️ Review focus 1: a row decided before the deploy (colour, no kind, a Livonia slug).
  it("counts a failed attempt for a pre-bunker row, registers nothing, and scrubs it at the second", async () => {
    await decide({ location: "dolnik", colour: "blue", kind: null, manual: true, detail: { by: "42" } });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    let row = (await state())!;
    expect(row.state).toBe("announced");
    expect(row.detail.enableAttempts).toBe(1);
    expect(row.detail.by).toBe("42");
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect(h.restart).toHaveBeenCalledWith("Scheduled restart");
    await db.delete(serverRestarts);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:04Z"), airdrop: { enabled: true } });
    row = (await state())!;
    expect(row.state).toBe("failed");
    expect(row.detail.enableAttempts).toBe(2);
  });

  // ⚠️ Review fix: the restart warning must not promise a bunker even when recording
  // the failed attempt itself throws (a database hiccup after a staging failure).
  it("does not advertise a bunker that failed to stage, even when recording the attempt throws", async () => {
    await decide();
    const h = host(GAMEPLAY, { "/mission/custom/keycard-bunker-boom.json": undefined });
    const flaky = new Proxy(db, {
      get(t, p) {
        if (p === "update") return () => { throw new Error("db hiccup"); };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;
    await restartTick(flaky, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage(null));
  });

  it("counts a failed attempt when the template is missing, and uploads nothing", async () => {
    await decide();
    const h = host(GAMEPLAY, { "/mission/custom/keycard-bunker-boom.json": undefined });
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect((await state())!.detail.enableAttempts).toBe(1);
    expect(String((await state())!.detail.error)).toMatch(/keycard-bunker-boom\.json/);
    expect(h.uploads).toEqual([]);
  });

  // ⚠️ `live` is recorded only AFTER the restart POST: recorded before it, a POST
  // that then fails leaves the row `live` for a session the server never loaded.
  it("does not mark the row live when the restart POST fails, and does not end it at the next slot", async () => {
    await decide();
    const h = host();
    h.restart.mockRejectedValueOnce(new Error("nitrado refused"));
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect((await state())!.state).toBe("announced");
    expect(h.spawners()).toContain("./custom/bunker-online.json");
    await restartTick(db, () => h.target, { now: at("2026-09-21T22:00:03Z"), airdrop: { enabled: true } });
    expect((await state())!.state).toBe("live");
    expect((await state())!.endedAt).toBeNull();
    expect(h.spawners()).toContain("./custom/bunker-online.json");
  });

  it("does nothing at all when the flag is off", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z") });
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect(h.uploads).toEqual([]);
    expect((await state())!.state).toBe("announced");
  });

  // ⚠️ A THROW out of the evaluate-and-upload block must not advertise a bunker
  // the file never got.
  it("does not advertise the bunker in the restart warning when cfggameplay.json evaluation throws", async () => {
    await decide();
    const h = host();
    h.target.missionRootDir = vi.fn(async () => { throw new Error("nitrado: mission root lookup failed"); });
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage(null));
    expect((await state())!.state).toBe("announced");
  });
});
