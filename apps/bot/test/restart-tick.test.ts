import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, servers, raidWindowFlips, type Database } from "@factions/db";
import { asc, eq, sql } from "drizzle-orm";
import { restartTick, RESTART_MESSAGE, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-12T14:00:00Z");

/** A Nitrado that answers a fixed status and records restarts. */
function fakeNitrado(statusValue = "started", restartImpl?: () => Promise<void>) {
  const restart = vi.fn(restartImpl ?? (async () => {}));
  const status = vi.fn(async () => statusValue);
  // ⚠️ The file methods throw rather than no-op: none of the tests using this fake
  // configure a truck wipe or a raid window, so reaching one of these means the
  // tick touched events.xml or cfggameplay.json when it had no business doing so,
  // and the test must say so loudly — with the reason that actually applies to it,
  // not a copy-pasted one (a wrong "without a configured truck wipe" message on
  // missionRootDir would point at the wrong feature when this fires).
  const unreachable = (name: string, reason = "without a configured truck wipe") => vi.fn(async () => {
    throw new Error(`${name} must not be called ${reason}`);
  });
  const target = {
    status,
    restart,
    missionDbDir: unreachable("missionDbDir"),
    missionRootDir: unreachable("missionRootDir", "without a configured raid window"),
    downloadFile: unreachable("downloadFile"),
    uploadFile: unreachable("uploadFile"),
  } as unknown as RestartTarget;
  return { target, restart, status };
}

describe("restartTick", () => {
  let db: Database; let serverId = 0;
  // ⚠️ Per-suite, not per-call: restartTick's default module-level map would
  // otherwise leak an entry across test FILES — "truncate ... restart
  // identity" resets ids to 1, so a later suite's server 1 could read a
  // stale error from this one. The retry test below still needs the error to
  // carry from one pass to the next WITHIN this suite, so it is cleared only
  // in beforeEach, not passed fresh per call.
  const lastError = new Map<number, string>();
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table server_restarts, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 4242, active: true }).returning();
    serverId = s!.id;
    lastError.clear();
  });
  const rows = () => db.select().from(serverRestarts).orderBy(asc(serverRestarts.scheduledFor));

  it("fires once per slot, in the slot's first minutes, and records it", async () => {
    const { target, restart } = fakeNitrado();
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:03Z"), lastError });
    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 0 });
    expect(restart).toHaveBeenCalledWith(RESTART_MESSAGE);
    expect(await rows()).toMatchObject([{ serverId, scheduledFor: SLOT, outcome: "restarted" }]);
    // The next pass, same slot: the row exists, nothing fires.
    const again = await restartTick(db, () => target, { now: at("2026-09-12T14:00:13Z"), lastError });
    expect(again).toEqual({ restarted: 0, skipped: 0, missed: 0, failed: 0 });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does nothing between slots", async () => {
    const { target, restart } = fakeNitrado();
    await restartTick(db, () => target, { now: at("2026-09-12T14:30:00Z"), lastError });
    // 14:30 is past 14:00's grace: recorded missed (below), but never restarted.
    expect(restart).not.toHaveBeenCalled();
    await restartTick(db, () => target, { now: at("2026-09-12T15:59:59Z"), lastError });
    expect(restart).not.toHaveBeenCalled();
  });

  it("catches up inside the grace window after downtime, and records missed after it", async () => {
    const { target, restart, status } = fakeNitrado();
    await restartTick(db, () => target, { now: at("2026-09-12T14:03:00Z"), lastError });
    expect(restart).toHaveBeenCalledTimes(1);
    await db.execute(sql`truncate table server_restarts`);
    status.mockClear();
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:20:00Z"), lastError });
    expect(r).toEqual({ restarted: 0, skipped: 0, missed: 1, failed: 0 });
    expect(restart).toHaveBeenCalledTimes(1);
    // ⚠️ The `missed` branch returns before any Nitrado call — that ordering
    // is the point: a slot past grace must never touch Nitrado at all.
    expect(status).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ scheduledFor: SLOT, outcome: "missed", detail: { reason: "not running" } }]);
  });

  it("retries a failed POST every pass until the window closes, then records missed with the error", async () => {
    let calls = 0;
    const { target, restart } = fakeNitrado("started", async () => { calls++; throw new Error("Nitrado 503 for /restart"); });
    const r1 = await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z"), lastError });
    expect(r1).toEqual({ restarted: 0, skipped: 0, missed: 0, failed: 1 });
    expect(await rows()).toEqual([]);                          // no row: the retry is what the next pass does
    await restartTick(db, () => target, { now: at("2026-09-12T14:00:10Z"), lastError });
    expect(calls).toBe(2);
    const r3 = await restartTick(db, () => target, { now: at("2026-09-12T14:10:00Z"), lastError });
    expect(r3).toEqual({ restarted: 0, skipped: 0, missed: 1, failed: 0 });
    expect(await rows()).toMatchObject([{ outcome: "missed", detail: { reason: "failed", error: "Nitrado 503 for /restart" } }]);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("then succeeds on a later pass: the retry that lands writes restarted", async () => {
    let n = 0;
    const { target } = fakeNitrado("started", async () => { if (n++ === 0) throw new Error("boom"); });
    await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z"), lastError });
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:10Z"), lastError });
    expect(r.restarted).toBe(1);
    expect(await rows()).toMatchObject([{ outcome: "restarted" }]);
  });

  it("⚠️ skips, with no POST, a server that is not `started` — a messages.xml shutdown in flight must not be followed by a second restart", async () => {
    const { target, restart } = fakeNitrado("restarting");
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z"), lastError });
    expect(r).toEqual({ restarted: 0, skipped: 1, missed: 0, failed: 0 });
    expect(restart).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ outcome: "skipped", detail: { status: "restarting" } }]);
  });

  it("one server's failure never blocks another's", async () => {
    const [s2] = await db.insert(servers).values({ name: "R2", map: "chernarus", clockOffsetMs: 0, nitradoServiceId: 5151, active: true }).returning();
    const bad = fakeNitrado("started", async () => { throw new Error("no"); });
    const good = fakeNitrado();
    const r = await restartTick(db, (id) => (id === 4242 ? bad.target : good.target), { now: at("2026-09-12T14:00:00Z"), lastError });
    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 1 });
    expect(good.restart).toHaveBeenCalledTimes(1);
    expect((await rows()).map((x) => x.serverId)).toEqual([s2!.id]);
  });

  it("never touches an inactive server or one with no service id", async () => {
    await db.insert(servers).values([
      { name: "off", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: false },
      { name: "nosvc", map: "livonia", clockOffsetMs: 0, nitradoServiceId: null, active: true },
    ]);
    const nitradoFor = vi.fn((_: number) => fakeNitrado().target);
    await restartTick(db, nitradoFor, { now: at("2026-09-12T14:00:00Z"), lastError });
    expect(nitradoFor.mock.calls.map((c) => c[0])).toEqual([4242]);
  });

  // ── Truck wipe ───────────────────────────────────────────────────────────
  // Level-triggered: every slot computes the state the server should boot into,
  // so a failed write self-heals at the next restart rather than leaving the
  // trucks off for a day.
  const XML = (active: number) =>
    `<events><event name="VehicleTruck01"><active>${active}</active></event></events>`;
  const WIPE = { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false };

  function fakeWithFiles(current = 1, opts: { failUpload?: boolean; failDir?: boolean } = {}) {
    const order: string[] = [];
    const uploads: Array<{ dir: string; name: string; content: string }> = [];
    const target = {
      status: vi.fn(async () => "started"),
      restart: vi.fn(async () => { order.push("restart"); }),
      missionDbDir: vi.fn(async () => {
        if (opts.failDir) throw new Error("no mission");
        return "/games/ni1/ftproot/dayzxb_missions/dayzOffline.enoch/db";
      }),
      downloadFile: vi.fn(async () => XML(current)),
      uploadFile: vi.fn(async (dir: string, name: string, content: string) => {
        if (opts.failUpload) throw new Error("upload boom");
        order.push("upload");
        uploads.push({ dir, name, content });
      }),
    } as unknown as RestartTarget;
    return { target, order, uploads, t: target as any };
  }

  it("disables the event at a slot inside the window, writing before the restart POST", async () => {
    const f = fakeWithFiles(1);
    const r = await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError, truckWipe: WIPE });
    expect(r.restarted).toBe(1);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]!.name).toBe("events.xml");
    expect(f.uploads[0]!.dir).toBe("/games/ni1/ftproot/dayzxb_missions/dayzOffline.enoch/db");
    expect(f.uploads[0]!.content).toContain("<active>0</active>");
    // ⚠️ DayZ reads events.xml only at boot: a write after the POST would not
    // take effect until the NEXT restart, two hours later.
    expect(f.order).toEqual(["upload", "restart"]);
  });

  it("re-enables the event at the slot that ends the window", async () => {
    const f = fakeWithFiles(0);
    await restartTick(db, () => f.target, { now: at("2026-09-12T10:00:03Z"), lastError, truckWipe: WIPE });
    expect(f.uploads[0]!.content).toContain("<active>1</active>");
  });

  // The self-healing property, end to end: a 10:00 write that never landed
  // leaves the file at 0, and the very next slot puts it back with no operator.
  it("recovers a missed re-enable at the next slot", async () => {
    const f = fakeWithFiles(0); // still disabled at noon — the 10:00 write failed
    await restartTick(db, () => f.target, { now: at("2026-09-12T12:00:03Z"), lastError, truckWipe: WIPE });
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]!.content).toContain("<active>1</active>");
  });

  it("never rewrites a file already in the wanted state", async () => {
    const f = fakeWithFiles(1); // on, and noon wants on
    const r = await restartTick(db, () => f.target, { now: at("2026-09-12T12:00:03Z"), lastError, truckWipe: WIPE });
    expect(f.uploads).toEqual([]);
    expect(f.t.downloadFile).toHaveBeenCalledTimes(1); // it still checks
    expect(r.restarted).toBe(1);
  });

  it("is off entirely when no events are configured", async () => {
    const f = fakeWithFiles(1);
    await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError, truckWipe: { ...WIPE, events: [] } });
    expect(f.t.downloadFile).not.toHaveBeenCalled();
    expect(f.uploads).toEqual([]);
  });

  it("is off entirely when no truckWipe is passed at all", async () => {
    const f = fakeWithFiles(1);
    await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError });
    expect(f.t.downloadFile).not.toHaveBeenCalled();
  });

  // ⚠️ The wipe must never cost a restart. Players rely on the 2-hour cadence.
  it("still restarts, and records the slot, when the upload fails", async () => {
    const f = fakeWithFiles(1, { failUpload: true });
    const r = await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError, truckWipe: WIPE });
    expect(r.restarted).toBe(1);
    expect(f.t.restart).toHaveBeenCalledWith(RESTART_MESSAGE);
    expect(await rows()).toMatchObject([{ serverId, outcome: "restarted" }]);
  });

  it("still restarts when the mission directory cannot be resolved", async () => {
    const f = fakeWithFiles(1, { failDir: true });
    const r = await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError, truckWipe: WIPE });
    expect(r.restarted).toBe(1);
  });

  it("does not touch events.xml for a server it is skipping", async () => {
    const f = fakeWithFiles(1);
    (f.t.status as any).mockResolvedValue("restarting");
    const r = await restartTick(db, () => f.target, { now: at("2026-09-12T08:00:03Z"), lastError, truckWipe: WIPE });
    expect(r.skipped).toBe(1);
    expect(f.t.downloadFile).not.toHaveBeenCalled();
    expect(f.uploads).toEqual([]);
  });

  // ── Weekly vehicle rotation ─────────────────────────────────────────────
  const FULL_XML = (truck: number, olga: number, gunter: number) =>
    `<events>` +
    `<event name="VehicleTruck01"><active>${truck}</active></event>` +
    `<event name="VehicleCivilianSedan"><active>${olga}</active></event>` +
    `<event name="VehicleHatchback02"><active>${gunter}</active></event>` +
    `<event name="VehicleOffroad02"><active>1</active></event>` +
    `<event name="VehicleOffroadHatchback"><active>1</active></event>` +
    `<event name="VehicleSedan02"><active>1</active></event>` +
    `</events>`;

  function fakeFullFiles(xml: string) {
    const uploads: Array<{ dir: string; name: string; content: string }> = [];
    const target = {
      status: vi.fn(async () => "started"),
      restart: vi.fn(async () => {}),
      missionDbDir: vi.fn(async () => "/m/db"),
      downloadFile: vi.fn(async () => xml),
      uploadFile: vi.fn(async (dir: string, name: string, content: string) => {
        uploads.push({ dir, name, content });
      }),
    } as unknown as RestartTarget;
    return { target, uploads, t: target as any };
  }

  const ROT = { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: true };
  const active = (xml: string, event: string) =>
    Number(new RegExp(`<event name="${event}"><active>(\\d)`).exec(xml)![1]);

  // 2026-09-14 is the anchor Monday: Olga's week.
  it("wipes the trucks AND this week's vehicle in one upload on the wipe Monday", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toHaveLength(1);
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(0);
    expect(active(x, "VehicleCivilianSedan")).toBe(0); // Olga
    expect(active(x, "VehicleHatchback02")).toBe(1);   // Gunter untouched
    expect(active(x, "VehicleSedan02")).toBe(1);
  });

  it("restores both at the on hour", async () => {
    const f = fakeFullFiles(FULL_XML(0, 0, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-14T10:00:03Z"), lastError, truckWipe: ROT });
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(1);
    expect(active(x, "VehicleCivilianSedan")).toBe(1);
  });

  // ⚠️ The convergence guarantee, end to end: the bot was down across Olga's Monday
  // 10:00, so the file still says 0. Gunter's week must put Olga back.
  it("heals a previous week's vehicle left disabled", async () => {
    const f = fakeFullFiles(FULL_XML(1, 0, 1)); // Olga still off
    await restartTick(db, () => f.target, { now: at("2026-09-21T12:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toHaveLength(1);
    expect(active(f.uploads[0]!.content, "VehicleCivilianSedan")).toBe(1);
  });

  it("writes nothing on an ordinary slot with everything already correct", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-16T12:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toEqual([]);
  });

  it("leaves the rotation alone entirely when rotation is off", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, {
      now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: { ...ROT, rotation: false },
    });
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(0);
    expect(active(x, "VehicleCivilianSedan")).toBe(1); // untouched
  });

  it("runs the rotation even with no daily truck events configured", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, {
      now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: { ...ROT, events: [] },
    });
    expect(f.uploads).toHaveLength(1);
    expect(active(f.uploads[0]!.content, "VehicleCivilianSedan")).toBe(0);
    expect(active(f.uploads[0]!.content, "VehicleTruck01")).toBe(1);
  });

  // ── Raid window flip ─────────────────────────────────────────────────────
  // Level-triggered, exactly like the truck wipe: every slot recomputes the
  // wanted disableBaseDamage value and re-uploads only on drift.
  const cfg = (disabled: boolean) => JSON.stringify({ GeneralData: { disableBaseDamage: disabled } });
  // Missing the key entirely — trips setBaseDamageDisabled's own guard, which is
  // exactly the "someone corrupted the file" case a refusal exists to catch.
  const BROKEN_CFG = JSON.stringify({ GeneralData: {} });

  function fakeRaid(initial: string, opts: { failUpload?: boolean; restartImpl?: () => Promise<void> } = {}) {
    let current = initial;
    const order: string[] = [];
    const uploads: Array<{ dir: string; name: string; content: string }> = [];
    const restart = vi.fn(opts.restartImpl ?? (async () => { order.push("restart"); }));
    const target = {
      status: vi.fn(async () => "started"),
      restart,
      missionRootDir: vi.fn(async () => "/mission"),
      downloadFile: vi.fn(async () => current),
      uploadFile: vi.fn(async (dir: string, name: string, content: string) => {
        if (opts.failUpload) throw new Error("upload boom");
        order.push("upload");
        uploads.push({ dir, name, content });
        current = content; // subsequent downloads see this tick's write
      }),
    } as unknown as RestartTarget;
    return {
      target, order, uploads, restart,
      setContent: (c: string) => { current = c; }, // simulate an operator's hand revert
      t: target as any,
    };
  }

  const raidRows = () => db.select().from(raidWindowFlips)
    .where(eq(raidWindowFlips.serverId, serverId)).orderBy(asc(raidWindowFlips.boundaryAt));

  const FRI_OPEN = at("2026-09-18T00:00:00Z");
  const MON_CLOSE_NEXT = at("2026-09-21T00:00:00Z");

  it("converges across a simulated week — missed slots and a hand-reverted file both self-heal", async () => {
    // Correctly closed already, from the prior Monday — nothing to do.
    const f = fakeRaid(cfg(true));
    await restartTick(db, () => f.target, { now: at("2026-09-14T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(f.uploads).toEqual([]);

    // ⚠️ A stretch of slots (through the rest of the week) never runs — the bot
    // is down. Nothing simulates that beyond simply not calling the tick for
    // them: the next call is the whole point of level-triggered.
    const r1 = await restartTick(db, () => f.target, { now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(r1.restarted).toBe(1);
    expect(f.uploads).toHaveLength(1);
    expect(JSON.parse(f.uploads[0]!.content).GeneralData.disableBaseDamage).toBe(false);
    let rows = await raidRows();
    expect(rows).toMatchObject([{ boundaryAt: FRI_OPEN, outcome: "applied", wantedDisabled: false }]);
    expect(rows[0]!.restartConfirmedAt).not.toBeNull();

    // An operator (or a lost write elsewhere) puts the file back to disabled —
    // a hand revert mid-weekend, well past the Friday slot.
    f.setContent(cfg(true));
    const r2 = await restartTick(db, () => f.target, { now: at("2026-09-19T12:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(r2.restarted).toBe(1);
    expect(f.uploads).toHaveLength(2);
    rows = await raidRows();
    // ⚠️ Still ONE row for this window — the repair upserts the same
    // (serverId, boundaryAt) key rather than adding a Saturday row of its own.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ boundaryAt: FRI_OPEN, outcome: "applied", wantedDisabled: false });

    // Monday close, several more missed slots later.
    const r3 = await restartTick(db, () => f.target, { now: at("2026-09-21T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(r3.restarted).toBe(1);
    expect(JSON.parse(f.uploads[2]!.content).GeneralData.disableBaseDamage).toBe(true);
    rows = await raidRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ boundaryAt: MON_CLOSE_NEXT, outcome: "applied", wantedDisabled: true });
  });

  it("⚠️ I1 — a restart failure right after a successful flip still gets confirmed once a later restart lands", async () => {
    let restartCalls = 0;
    const f = fakeRaid(cfg(true), {
      restartImpl: async () => {
        restartCalls++;
        if (restartCalls === 1) throw new Error("Nitrado 503 for /restart");
      },
    });
    // First pass at the boundary: the upload succeeds, the row is written
    // `applied`, then the restart POST throws — the per-server catch swallows
    // it, and nothing confirms the row.
    const r1 = await restartTick(db, () => f.target, { now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(r1.failed).toBe(1);
    let rows = await raidRows();
    expect(rows).toMatchObject([{ outcome: "applied", wantedDisabled: false }]);
    expect(rows[0]!.restartConfirmedAt).toBeNull();

    // Later pass, same slot (no server_restarts row was written on the failed
    // attempt, so this retries it): the file is ALREADY in the wanted state, so
    // `changed` is false this time — and the restart now succeeds. Gating the
    // confirm write on `changed` would leave the row unconfirmed forever; the
    // confirm-by-lookup must still find and confirm it.
    const r2 = await restartTick(db, () => f.target, { now: at("2026-09-18T00:05:00Z"), lastError, raidWindow: { enabled: true } });
    expect(r2.restarted).toBe(1);
    expect(f.uploads).toHaveLength(1); // no second upload — it was already correct
    rows = await raidRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.restartConfirmedAt).not.toBeNull();
  });

  it("uploads before the restart POST", async () => {
    const f = fakeRaid(cfg(true));
    await restartTick(db, () => f.target, { now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(f.order).toEqual(["upload", "restart"]);
  });

  it("does not confirm when the restart POST fails, even though the upload already succeeded", async () => {
    const f = fakeRaid(cfg(true), { restartImpl: async () => { throw new Error("boom"); } });
    await restartTick(db, () => f.target, { now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    const rows = await raidRows();
    expect(rows).toMatchObject([{ outcome: "applied" }]);
    expect(rows[0]!.restartConfirmedAt).toBeNull();
  });

  it("⚠️ setWhere: a later refusal never downgrades an already-applied row", async () => {
    const f = fakeRaid(cfg(true));
    await restartTick(db, () => f.target, { now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true } });
    let rows = await raidRows();
    expect(rows).toMatchObject([{ outcome: "applied" }]);
    const confirmedAt = rows[0]!.restartConfirmedAt;

    // A later pass in the SAME window finds a file some other actor corrupted —
    // the guard in setBaseDamageDisabled refuses it.
    f.setContent(BROKEN_CFG);
    const r2 = await restartTick(db, () => f.target, { now: at("2026-09-19T12:00:03Z"), lastError, raidWindow: { enabled: true } });
    expect(r2.restarted).toBe(1); // the refusal never costs the restart
    rows = await raidRows();
    expect(rows).toHaveLength(1);
    // ⚠️ Still `applied`, not downgraded to `refused` — and the earlier
    // confirmation survives, which is the whole point of setWhere: without it,
    // this refusal would make the website stop saying LIVE for a window that
    // genuinely is live.
    expect(rows[0]!.outcome).toBe("applied");
    expect(rows[0]!.restartConfirmedAt).toEqual(confirmedAt);
  });

  it("a refused flip still restarts the server, and one server's refusal does not block another's", async () => {
    const bad = fakeRaid(BROKEN_CFG); // the guard rejects from the very first pass
    const good = fakeRaid(cfg(true));
    const [s2] = await db.insert(servers).values({ name: "R2", map: "chernarus", clockOffsetMs: 0, nitradoServiceId: 5151, active: true }).returning();
    const r = await restartTick(db, (id) => (id === 4242 ? bad.target : good.target), {
      now: at("2026-09-18T00:00:03Z"), lastError, raidWindow: { enabled: true },
    });
    expect(r.restarted).toBe(2);
    expect(bad.restart).toHaveBeenCalledTimes(1);
    expect(good.restart).toHaveBeenCalledTimes(1);
    const badRows = await db.select().from(raidWindowFlips).where(eq(raidWindowFlips.serverId, serverId));
    expect(badRows).toMatchObject([{ outcome: "refused" }]);
    const goodRows = await db.select().from(raidWindowFlips).where(eq(raidWindowFlips.serverId, s2!.id));
    expect(goodRows).toMatchObject([{ outcome: "applied" }]);
  });
});

