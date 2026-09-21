import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restartTick, restartMessage, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-21T20:00:00Z");
const GAMEPLAY = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");

function host(content = GAMEPLAY) {
  let stored = content;
  const restart = vi.fn(async () => {});
  const target = {
    status: vi.fn(async () => "started"), restart,
    missionDbDir: vi.fn(async () => "/db"), missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async () => stored),
    uploadFile: vi.fn(async (_d: string, _n: string, b: string) => { stored = b; }),
  } as unknown as RestartTarget;
  return { target, restart, spawners: () => JSON.parse(stored).WorldsData.objectSpawnersArr as string[] };
}

describe("the airdrop at the slot", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, server_restarts, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const decide = (over: Record<string, unknown> = {}) => db.insert(airdropEvents).values({
    serverId, slotAt: SLOT, location: "dolnik", colour: "blue", decidedAt: at("2026-09-21T19:30:00Z"),
    popAtDecision: 6, threshold: "5", state: "announced", announcedAt: at("2026-09-21T19:30:01Z"), ...over,
  });
  const state = async () => (await db.select().from(airdropEvents).where(eq(airdropEvents.slotAt, SLOT)))[0];

  it("registers the spawner at the slot and marks the row live", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/airdrop-dolnik-blue.json");
    expect((await state())!.state).toBe("live");
  });

  it("takes it away at the next slot and marks the row ended", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T22:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("ended");
    expect((await state())!.endedAt).not.toBeNull();
  });

  // ⚠️ Spec §9: a drop nobody was told about is strictly worse than no drop.
  it("never enables a row whose announcement has not posted", async () => {
    await decide({ announcedAt: null });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("announced");
  });

  // ⚠️ Level-triggered (spec §6): this is what survives the livonia FTP deploy
  // clobbering the file mid-event.
  it("puts a drop back that something else removed, while its session is running", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/airdrop-dolnik-blue.json");
  });

  it("carries the location in the in-game restart warning, and only for that slot", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage("dolnik"));
    expect(restartMessage("dolnik")).toContain("Dolnik");
    expect(restartMessage(null)).toBe("Scheduled restart");
  });

  // ⚠️ Spec §9: nothing here may cost the restart.
  it("restarts anyway when the splice refuses, and records the refusal", async () => {
    await decide();
    const twoDrops = GAMEPLAY.replace(
      '"./custom/admin-castle.json"',
      '"./custom/airdrop-lukow-blue.json",\n\t\t\t"./custom/airdrop-nadbor-blue.json"',
    );
    const h = host(twoDrops);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalled();
    const row = (await state())!;
    expect(row.state).toBe("announced");
    expect(row.detail.enableAttempts).toBe(1);
  });

  // Renamed from "scrubs the drop after two failed enables and refunds the
  // budget": nothing in this commit implements a budget refund, so the title
  // now says only what the assertions below actually prove.
  it("marks the row failed after two failed enables, and still restarts", async () => {
    await decide({ detail: { enableAttempts: 1 } });
    const twoDrops = GAMEPLAY.replace(
      '"./custom/admin-castle.json"',
      '"./custom/airdrop-lukow-blue.json",\n\t\t\t"./custom/airdrop-nadbor-blue.json"',
    );
    const h = host(twoDrops);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    const row = (await state())!;
    expect(row.state).toBe("failed");
    expect(row.detail.enableAttempts).toBe(2);
    expect(row.endedAt).not.toBeNull();
    expect(h.restart).toHaveBeenCalled();
  });

  it("does nothing at all when the flag is off", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z") });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("announced");
  });

  // ⚠️ Fix round 1, Important 2: a THROW out of the shared evaluate-and-upload
  // block (not a splice refusal) must scrub the location too, or the in-game
  // restart warning advertises a drop the file never actually got.
  it("does not advertise the drop in the restart warning when cfggameplay.json evaluation throws", async () => {
    await decide();
    const h = host();
    h.target.missionRootDir = vi.fn(async () => {
      throw new Error("nitrado: mission root lookup failed");
    });
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage(null));
    expect((await state())!.state).toBe("announced");
  });
});
