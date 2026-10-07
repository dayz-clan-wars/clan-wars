import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, serverRestarts, servers, type Database } from "@factions/db";
import { KOTH_PRESET_FILES } from "@factions/domain";
import { eq, sql } from "drizzle-orm";
import { planKoth, convergeKothFiles } from "../src/koth-converge.js";
import { narrowFreshSpawns } from "../src/spawn-points.js";
import { restartTick, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NEXT = at("2026-10-03T22:00:00Z");

const GAMEPLAY = `{\n\t"PlayerData": {\n\t\t"spawnGearPresetFiles": [\n\t\t\t"./custom/loadout.json"\n\t\t]\n\t}\n}`;
const GLOBALS = (player: number, infected: number, avoid: number) => `<variables>
    <var name="CleanupAvoidance" type="0" value="${avoid}"/>
    <var name="CleanupLifetimeDeadInfected" type="0" value="${infected}"/>
    <var name="CleanupLifetimeDeadPlayer" type="0" value="${player}"/>
    <var name="ZombieMaxCount" type="0" value="1000"/>
</variables>`;
const SPAWNS = `<playerspawnpoints>
    <fresh>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="4491.000000" z="2312.000000" />
            </group>
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
</playerspawnpoints>
`;
const BEREZINO = narrowFreshSpawns(SPAWNS, "Berezino");

/** A mission on a fake Nitrado: every KotH source and default present unless `over` removes it. */
function mission(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    "/m/cfggameplay.json": GAMEPLAY,
    "/m/cfgplayerspawnpoints.xml": SPAWNS,
    "/m/koth/default/cfgplayerspawnpoints.xml": SPAWNS,
    "/m/db/globals.xml": GLOBALS(3600, 330, 100),
    "/m/koth/default/globals.xml": GLOBALS(3600, 330, 100),
    ...Object.fromEntries(KOTH_PRESET_FILES.map((p) => [`/m/custom/${p.slice("./custom/".length)}`, "{}"])),
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete files[k]; else files[k] = v; }
  const store = new Map(Object.entries(files));
  const uploadFile = vi.fn(async (dir: string, name: string, body: string) => { store.set(`${dir}/${name}`, body); });
  // ⚠️ Predators and infected are gone (spec §3.3): touching either is a test failure.
  const forbidden = (p: string) => p.includes("/env/") || p.endsWith("/events.xml");
  const target = {
    missionRootDir: async () => "/m", missionDbDir: async () => "/m/db",
    downloadFile: async (p: string) => {
      if (forbidden(p)) throw new Error(`KotH must not read ${p}`);
      const v = store.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v;
    },
    listFiles: async (d: string) => [...store.keys()].filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/")).map((k) => k.slice(d.length + 1)),
    uploadFile,
  } as unknown as RestartTarget;
  return { target, uploadFile, read: (p: string) => store.get(p) };
}

let db: Database; let serverId = 0;
beforeEach(async () => {
  db = createClient(URL); await runMigrations(db);
  await db.execute(sql`truncate table koth_events, server_restarts, servers restart identity cascade`);
  // ⚠️ nitradoServiceId: restartTick only targets servers that have one.
  const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
  serverId = s!.id;
});
const schedule = (over: Record<string, unknown> = {}) => db.insert(kothEvents).values({
  serverId, slotAt: SLOT, location: "berezino", centreX: "12900", centreZ: "9900", state: "scheduled",
  scheduledByDiscordId: "1", announcedAt: at("2026-10-01T00:00:00Z"), ...over,
}).returning().then((r) => r[0]!);
const kothGameplay = GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json");

describe("planKoth", () => {
  it("is null when no KotH event has ever existed — nothing to open or restore", async () => {
    expect(await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true })).toBeNull();
  });

  it("opens: the presets, the narrowed spawn file and the three globals, snapshot first", async () => {
    const row = await schedule();
    const p = (await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toBeNull();
    expect(p.opening?.id).toBe(row.id);
    expect(p.presets).toEqual([...KOTH_PRESET_FILES]);
    expect(p.files).toEqual([
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: BEREZINO },
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(30, 10, 5) },
    ]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toEqual(["./custom/loadout.json"]);
  });

  // ⚠️ Spec §3.1: a KotH we could not reverse is worse than one that never starts.
  for (const [what, over, msg] of [
    ["a missing default spawn file", { "/m/koth/default/cfgplayerspawnpoints.xml": undefined }, /koth\/default\/cfgplayerspawnpoints\.xml/],
    ["an empty default spawn file", { "/m/koth/default/cfgplayerspawnpoints.xml": "  \n" }, /is empty/],
    ["a default spawn file without the town's group", { "/m/koth/default/cfgplayerspawnpoints.xml": SPAWNS.replace(/<group name="Berezino">[\s\S]*?<\/group>\n/, "") }, /no group "Berezino"/],
    ["a missing default globals.xml", { "/m/koth/default/globals.xml": undefined }, /koth\/default\/globals\.xml/],
    ["a default globals.xml without CleanupAvoidance", { "/m/koth/default/globals.xml": GLOBALS(3600, 330, 100).replace(/.*CleanupAvoidance.*\n/, "") }, /CleanupAvoidance/],
    ["a missing preset", { [`/m/custom/${KOTH_PRESET_FILES[0]!.slice(9)}`]: undefined }, /preset/],
  ] as const) {
    it(`${what} refuses: failed, nothing KotH planned, nothing uploaded`, async () => {
      const row = await schedule();
      const m = mission(over as Record<string, string | undefined>);
      const p = (await planKoth(db, m.target, serverId, SLOT, { allowOpen: true }))!;
      expect(p.failure).toMatch(msg);
      expect(p.opening).toBeNull();
      expect(p.presets).toBeNull();
      expect(m.uploadFile).not.toHaveBeenCalled();
      const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
      expect(saved!.state).toBe("failed");
      expect(saved!.loadoutSnapshot).toBeNull();
    });
  }

  // ⚠️ Review focus 3: a row scheduled on Livonia reaching its slot on Chernarus.
  it("a retired Livonia town refuses with a reason rather than throwing", async () => {
    await schedule({ location: "adamow" });
    const p = (await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toMatch(/adamow is not one of the 31 KotH towns/);
    expect(p.opening).toBeNull();
  });

  // ⚠️ Spec §2.5 of the original: a retried open must never snapshot KotH's own state as the default.
  it("never snapshots a list that already holds koth- entries", async () => {
    const row = await schedule();
    await planKoth(db, mission({ "/m/cfggameplay.json": kothGameplay }).target, serverId, SLOT, { allowOpen: true });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toBeNull();
  });

  it("restores at the next slot: snapshot presets, default spawn file, default globals", async () => {
    await schedule({ state: "live", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"] });
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO, "/m/db/globals.xml": GLOBALS(30, 10, 5) });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.opening).toBeNull();
    expect(p.presets).toEqual(["./custom/loadout.json"]);
    expect(p.files).toEqual([
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: SPAWNS },
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(3600, 330, 100) },
    ]);
  });

  it("restores globals.xml from koth/default, including a default retuned since the session opened", async () => {
    await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/db/globals.xml": GLOBALS(30, 10, 5), "/m/koth/default/globals.xml": GLOBALS(1800, 330, 80) });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.files).toEqual([{ dir: "/m/db", name: "globals.xml", content: GLOBALS(1800, 330, 80) }]);
  });

  // ⚠️ Skip, never blank.
  it("a missing default spawn file at restore skips it and records why; globals still restore", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/cfgplayerspawnpoints.xml": BEREZINO, "/m/db/globals.xml": GLOBALS(30, 10, 5),
      "/m/koth/default/cfgplayerspawnpoints.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.files).toEqual([{ dir: "/m/db", name: "globals.xml", content: GLOBALS(3600, 330, 100) }]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/koth\/default\/cfgplayerspawnpoints\.xml/);
  });

  // ⚠️ A refused preset restore leaves ONLY the preset list alone.
  it("a refused preset restore leaves the list alone and records why; the spawn file still restores", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.files).toEqual([{ dir: "/m", name: "cfgplayerspawnpoints.xml", content: SPAWNS }]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/spawnGearPresetFiles/);
  });

  it("a later user edit survives: no koth- entry → nothing touched", async () => {
    await schedule({ state: "no_winner", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"] });
    const edited = GAMEPLAY.replace('"./custom/loadout.json"', '"./custom/loadout.json",\n\t\t\t"./custom/extra.json"');
    const p = (await planKoth(db, mission({ "/m/cfggameplay.json": edited }).target, serverId, at("2026-10-04T10:00:00Z"), { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.files).toEqual([]);
  });
});

describe("convergeKothFiles", () => {
  it("uploads each edit; one failure does not stop the rest", async () => {
    const m = mission();
    const upload = m.uploadFile.getMockImplementation()!;
    m.uploadFile.mockImplementation(async (dir: string, name: string, body: string) => {
      if (name === "globals.xml") throw new Error("ftp refused");
      return upload(dir, name, body);
    });
    const r = await convergeKothFiles(m.target, [
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(30, 10, 5) },
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: BEREZINO },
    ]);
    expect(r.uploaded).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/\/m\/db\/globals\.xml: ftp refused/)]);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(BEREZINO);
  });
});

describe("restartTick with KotH", () => {
  it("opens at the slot and goes live only after the restart POST; restores at the next slot", async () => {
    const row = await schedule({ location: "novaya-petrovka" });
    const spawns = SPAWNS.replace('"Berezino"', '"NovayaPetrovka"');
    const m = mission({ "/m/cfgplayerspawnpoints.xml": spawns, "/m/koth/default/cfgplayerspawnpoints.xml": spawns });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    // ⚠️ Review focus 5: the display name, never a capitalised slug.
    expect(restart).toHaveBeenCalledWith(expect.stringContaining("King of the Hill at Novaya Petrovka"));
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(narrowFreshSpawns(spawns, "NovayaPetrovka"));
    expect(m.read("/m/cfggameplay.json")).toContain("./custom/koth-");
    expect(m.read("/m/db/globals.xml")).toBe(GLOBALS(30, 10, 5));
    let [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");

    await restartTick(db, () => target, { now: at("2026-10-03T22:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(spawns);
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/db/globals.xml")).toBe(GLOBALS(3600, 330, 100));
    [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");
  });

  // ⚠️ KOTH_TICK off must never OPEN a session, but the restore arm runs regardless.
  it("with KOTH_TICK off, a due row is not opened and stays scheduled; an earlier session still restores", async () => {
    await schedule({ slotAt: at("2026-10-03T18:00:00Z"), state: "no_winner", openedAt: at("2026-10-03T18:00:00Z"), loadoutSnapshot: ["./custom/loadout.json"] });
    const row = await schedule();
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    for (const koth of [{ open: false }, undefined]) {
      await db.delete(serverRestarts);
      await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth });
      expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
      const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
      expect(saved!.state).toBe("scheduled");
    }
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(SPAWNS);
  });

  it("a failed restart POST leaves the row scheduled, not live", async () => {
    const row = await schedule();
    const target = { ...mission().target, status: async () => "started", restart: async () => { throw new Error("503"); } } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("scheduled");
  });

  it("a refused opening still restarts, as a normal restart, with nothing KotH uploaded", async () => {
    const row = await schedule();
    const m = mission({ "/m/koth/default/cfgplayerspawnpoints.xml": undefined });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    const r = await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(r.restarted).toBe(1);
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    expect(m.uploadFile).not.toHaveBeenCalled();
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
  });

  it("a refused preset splice fails the row, never advertises it, and still restarts", async () => {
    const row = await schedule();
    const twice = GAMEPLAY.replace('"PlayerData": {', '"PlayerData": {\n\t\t"spawnGearPresetFiles": ["./custom/loadout.json"],');
    const m = mission({ "/m/cfggameplay.json": twice });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    const r = await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(r.restarted).toBe(1);
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
    expect(String(saved!.detail.failure)).toMatch(/spawnGearPresetFiles/);
  });
});
