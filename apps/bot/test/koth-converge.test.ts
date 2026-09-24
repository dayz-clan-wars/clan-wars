import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, serverRestarts, servers, type Database } from "@factions/db";
import { KOTH_PRESET_FILES, KOTH_WHOLE_FILES } from "@factions/domain";
import { eq, sql } from "drizzle-orm";
import { planKoth, convergeKothFiles } from "../src/koth-converge.js";
import { restartTick, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NEXT = at("2026-10-03T22:00:00Z");

const GAMEPLAY = `{\n\t"PlayerData": {\n\t\t"spawnGearPresetFiles": [\n\t\t\t"./custom/loadout.json"\n\t\t]\n\t}\n}`;
const EVENTS = `<events>${["InfectedCity", "InfectedVillage", "InfectedArmy", "InfectedPolice", "InfectedMedic"]
  .map((n, i) => `<event name="${n}"><active>${i === 0 ? 1 : 0}</active></event>`).join("")}</events>`;

/** A mission on a fake Nitrado: every KotH source and default present unless `over` removes it. */
function mission(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    "/m/cfggameplay.json": GAMEPLAY,
    "/m/db/events.xml": EVENTS,
    ...Object.fromEntries(KOTH_PRESET_FILES.map((p) => [`/m/custom/${p.slice("./custom/".length)}`, "{}"])),
  };
  for (const f of KOTH_WHOLE_FILES) {
    const live = f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`;
    files[live] = `default ${f.name}`;
    files[`/m/koth/default/${f.name}`] = `default ${f.name}`;
    files[`/m/koth/locations/lembork/${f.name}`] = `lembork ${f.name}`;
  }
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete files[k]; else files[k] = v; }
  const store = new Map(Object.entries(files));
  const uploadFile = vi.fn(async (dir: string, name: string, body: string) => { store.set(`${dir}/${name}`, body); });
  const target = {
    missionRootDir: async () => "/m", missionDbDir: async () => "/m/db",
    downloadFile: async (p: string) => { const v = store.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v; },
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
  const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
  serverId = s!.id;
});
const schedule = (over: Record<string, unknown> = {}) => db.insert(kothEvents).values({
  serverId, slotAt: SLOT, location: "lembork", centreX: "8675", centreZ: "6635", state: "scheduled",
  scheduledByDiscordId: "1", announcedAt: at("2026-10-01T00:00:00Z"), ...over,
}).returning().then((r) => r[0]!);

describe("planKoth", () => {
  it("is null when no KotH event has ever existed — nothing to open or restore", async () => {
    expect(await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true })).toBeNull();
  });

  it("opens: the presets, all five infected on, the four town files, and snapshots first", async () => {
    const row = await schedule();
    const p = (await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toBeNull();
    expect(p.opening?.id).toBe(row.id);
    expect(p.presets).toEqual([...KOTH_PRESET_FILES]);
    expect(p.infected).toEqual({ InfectedCity: 1, InfectedVillage: 1, InfectedArmy: 1, InfectedPolice: 1, InfectedMedic: 1 });
    expect(p.files.map((f) => f.content)).toEqual(KOTH_WHOLE_FILES.map((f) => `lembork ${f.name}`));
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toEqual(["./custom/loadout.json"]);
    expect(saved!.infectedSnapshot).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
  });

  // ⚠️ Spec §5.1: a KotH we could not reverse is worse than one that never starts.
  it("missing default refuses: failed, restore plan, nothing KotH in it", async () => {
    const row = await schedule();
    const m = mission({ "/m/koth/default/zombie_territories.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toMatch(/koth\/default\/zombie_territories\.xml/);
    expect(p.opening).toBeNull();
    expect(p.presets).toBeNull();
    expect(p.infected).toBeNull();
    expect(p.files).toEqual([]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
    expect(saved!.loadoutSnapshot).toBeNull();
    expect(m.uploadFile).not.toHaveBeenCalled();
  });

  it("an empty town source refuses too — an empty spawn file is never uploaded", async () => {
    await schedule();
    const p = (await planKoth(db, mission({ "/m/koth/locations/lembork/cfgplayerspawnpoints.xml": "  \n" }).target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toMatch(/is empty/);
    expect(p.opening).toBeNull();
  });

  it("a missing preset on the server refuses too", async () => {
    await schedule();
    const p = (await planKoth(db, mission({ [`/m/custom/${KOTH_PRESET_FILES[0]!.slice(9)}`]: undefined }).target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toMatch(/preset/);
  });

  // ⚠️ Spec §2.5: a retried open must never snapshot KotH's own state as the default.
  it("never snapshots a list that already holds koth- entries", async () => {
    const row = await schedule();
    const kothGameplay = GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json");
    await planKoth(db, mission({ "/m/cfggameplay.json": kothGameplay }).target, serverId, SLOT, { allowOpen: true });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toBeNull();
  });

  it("a retried open keeps the first attempt's snapshots", async () => {
    const row = await schedule({
      loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 },
    });
    const allOn = EVENTS.replace(/<active>0<\/active>/g, "<active>1</active>");
    await planKoth(db, mission({ "/m/db/events.xml": allOn }).target, serverId, SLOT, { allowOpen: true });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.infectedSnapshot).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
  });

  it("restores at the next slot: snapshot presets, snapshot infected, default files", async () => {
    const row = await schedule({
      state: "live", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 },
    });
    const live = Object.fromEntries(KOTH_WHOLE_FILES.map((f) => [f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`, `lembork ${f.name}`]));
    const m = mission({ ...live, "/m/cfggameplay.json": GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json") });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.opening).toBeNull();
    expect(p.presets).toEqual(["./custom/loadout.json"]);
    expect(p.infected).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
    expect(p.infectedRestoreRowId).toBe(row.id);
    expect(p.files.map((f) => f.content)).toEqual(KOTH_WHOLE_FILES.map((f) => `default ${f.name}`));
  });

  // ⚠️ Skip, never blank (spec §5.3).
  it("a missing default at restore skips that file and records why; the others still restore", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const live = Object.fromEntries(KOTH_WHOLE_FILES.map((f) => [f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`, `lembork ${f.name}`]));
    const m = mission({ ...live, "/m/koth/default/bear_territories.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.files.map((f) => f.name)).toEqual(KOTH_WHOLE_FILES.map((f) => f.name).filter((n) => n !== "bear_territories.xml"));
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/bear_territories\.xml/);
  });

  // ⚠️ Spec §5.3: a preset list that would restore to empty leaves ONLY the preset
  // list alone. It once threw out of planKoth, and the infected and whole-file
  // restores were skipped with it — every slot, indefinitely.
  it("a refused preset restore leaves the list alone and records why; infected and files still restore", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT,
      infectedSnapshot: { InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 } });
    const live = Object.fromEntries(KOTH_WHOLE_FILES.map((f) => [f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`, `lembork ${f.name}`]));
    const m = mission({ ...live, "/m/cfggameplay.json": GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json") });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.infected).toEqual({ InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 });
    expect(p.infectedRestoreRowId).toBe(row.id);
    expect(p.files.map((f) => f.content)).toEqual(KOTH_WHOLE_FILES.map((f) => `default ${f.name}`));
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/spawnGearPresetFiles/);
  });

  it("a refused preset restore and a missing default in one slot record both, neither overwriting the other", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/cfggameplay.json": GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json"),
      "/m/koth/default/bear_territories.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/spawnGearPresetFiles/);
    expect(String(saved!.detail.restoreError)).toMatch(/bear_territories\.xml/);
  });

  // ⚠️ Review focus #1: the operator's own later edits must survive.
  it("a later user edit survives: no koth- entry, restored_at set → nothing touched", async () => {
    await schedule({ state: "no_winner", openedAt: SLOT, restoredAt: NEXT, loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 0, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 } });
    const edited = GAMEPLAY.replace('"./custom/loadout.json"', '"./custom/loadout.json",\n\t\t\t"./custom/extra.json"');
    const p = (await planKoth(db, mission({ "/m/cfggameplay.json": edited }).target, serverId, at("2026-10-04T10:00:00Z"), { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.infected).toBeNull();
    expect(p.files).toEqual([]);
  });
});

describe("convergeKothFiles", () => {
  // The differing-only filter is planKoth's (its `files` tests above); this uploads what it is given.
  it("uploads each edit to root or env; one failure does not stop the rest", async () => {
    const m = mission();
    const upload = m.uploadFile.getMockImplementation()!;
    m.uploadFile.mockImplementation(async (dir: string, name: string, body: string) => {
      if (name === "bear_territories.xml") throw new Error("ftp refused");
      return upload(dir, name, body);
    });
    const r = await convergeKothFiles(m.target, [
      { dir: "/m/env", name: "bear_territories.xml", content: "lembork bear_territories.xml" },
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: "lembork cfgplayerspawnpoints.xml" },
      { dir: "/m/env", name: "wolf_territories.xml", content: "lembork wolf_territories.xml" },
    ]);
    expect(r.uploaded).toBe(2);
    expect(r.errors).toEqual([expect.stringMatching(/\/m\/env\/bear_territories\.xml: ftp refused/)]);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("lembork cfgplayerspawnpoints.xml");
    expect(m.read("/m/env/wolf_territories.xml")).toBe("lembork wolf_territories.xml");
  });
});

describe("restartTick with KotH", () => {
  it("opens at the slot and goes live only after the restart POST; restores at the next slot", async () => {
    const row = await schedule();
    const m = mission();
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(restart).toHaveBeenCalledWith(expect.stringContaining("King of the Hill at Lembork"));
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("lembork cfgplayerspawnpoints.xml");
    expect(m.read("/m/env/zombie_territories.xml")).toBe("lembork zombie_territories.xml");
    expect(m.read("/m/cfggameplay.json")).toContain("./custom/koth-");
    expect(m.read("/m/db/events.xml")).not.toContain("<active>0</active>");
    let [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");
    expect(saved!.openedAt).not.toBeNull();

    await restartTick(db, () => target, { now: at("2026-10-03T22:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("default cfgplayerspawnpoints.xml");
    expect(m.read("/m/env/zombie_territories.xml")).toBe("default zombie_territories.xml");
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/db/events.xml")).toBe(EVENTS);
    [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.restoredAt).not.toBeNull();
  });

  // ⚠️ FI2: KOTH_TICK off must never OPEN a session (nothing would score or post it),
  // but the restore arm runs regardless — switching off mid-event still puts the server back.
  it("with KOTH_TICK off, a due row is not opened and stays scheduled; an earlier session still restores", async () => {
    const prior = await schedule({ slotAt: at("2026-10-03T18:00:00Z"), state: "no_winner", openedAt: at("2026-10-03T18:00:00Z"),
      loadoutSnapshot: ["./custom/loadout.json"],
      infectedSnapshot: { InfectedCity: 1, InfectedVillage: 0, InfectedArmy: 0, InfectedPolice: 0, InfectedMedic: 0 } });
    const row = await schedule();
    const live = Object.fromEntries(KOTH_WHOLE_FILES.map((f) => [f.dir === "root" ? `/m/${f.name}` : `/m/env/${f.name}`, `lembork ${f.name}`]));
    const allOn = EVENTS.replace(/<active>0<\/active>/g, "<active>1</active>");
    const m = mission({ ...live, "/m/db/events.xml": allOn, "/m/cfggameplay.json": GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json") });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    for (const koth of [{ open: false }, undefined]) {
      await db.delete(serverRestarts);
      await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth });
      expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
      const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
      expect(saved!.state).toBe("scheduled");
      expect(saved!.loadoutSnapshot).toBeNull();
    }
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/db/events.xml")).toBe(EVENTS);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("default cfgplayerspawnpoints.xml");
    const [p] = await db.select().from(kothEvents).where(eq(kothEvents.id, prior.id));
    expect(p!.restoredAt).not.toBeNull();
  });

  // ⚠️ FT9: an opening that already failed must not put KotH's presets in the file.
  it("an opening whose events.xml write fails does not upload the koth- presets", async () => {
    const row = await schedule();
    const m = mission();
    const upload = m.uploadFile.getMockImplementation()!;
    m.uploadFile.mockImplementation(async (dir: string, name: string, body: string) => {
      if (name === "events.xml") throw new Error("ftp refused");
      return upload(dir, name, body);
    });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe("default cfgplayerspawnpoints.xml");
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
  });

  it("a failed restart POST leaves the row scheduled, not live", async () => {
    const row = await schedule();
    const target = { ...mission().target, status: async () => "started", restart: async () => { throw new Error("503"); } } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("scheduled");
  });

  // ⚠️ Spec §5.1: a refused opening costs the event, never the restart.
  it("a refused opening still restarts, as a normal restart, with nothing KotH uploaded", async () => {
    const row = await schedule();
    const m = mission({ "/m/koth/default/wolf_territories.xml": undefined });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    const r = await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(r.restarted).toBe(1);
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    expect(m.uploadFile).not.toHaveBeenCalled();
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
  });

  // ⚠️ Spec §5.1 step 3: an edit that fails at open marks the row failed; the restart proceeds.
  it("a refused preset splice fails the row, never advertises it, and still restarts", async () => {
    const row = await schedule();
    // Two spawnGearPresetFiles keys: readSpawnGearPresets parses (JSON keeps the last),
    // setSpawnGearPresets refuses to guess.
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
