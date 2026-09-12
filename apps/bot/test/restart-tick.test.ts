import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, servers, type Database } from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { restartTick, RESTART_MESSAGE, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-12T14:00:00Z");

/** A Nitrado that answers a fixed status and records restarts. */
function fakeNitrado(statusValue = "started", restartImpl?: () => Promise<void>) {
  const restart = vi.fn(restartImpl ?? (async () => {}));
  const status = vi.fn(async () => statusValue);
  // ⚠️ The file methods throw rather than no-op: none of the tests using this fake
  // configure a truck wipe, so reaching one of these means the tick touched
  // events.xml when it had no business doing so, and the test must say so loudly.
  const unreachable = (name: string) => vi.fn(async () => {
    throw new Error(`${name} must not be called without a configured truck wipe`);
  });
  const target = {
    status,
    restart,
    missionDbDir: unreachable("missionDbDir"),
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
  const WIPE = { events: ["VehicleTruck01"], offHour: 8, onHour: 10 };

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
});

