import { describe, it, expect, vi } from "vitest";
import { dormancyTick } from "../src/dormancy-tick.js";
import { DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "../src/dormancy.js";
import type { DormancyStore, FactionClockRow } from "../src/dormancy-store.js";

const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const windows = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};

const row = (o: Partial<FactionClockRow>): FactionClockRow => ({
  id: 1, name: "Bears", tag: "BEAR", leaderDiscordId: "d1",
  // serverLastEventAt defaults to "now" — live — so existing cases keep
  // exercising the branch they always did; the liveness gate itself is
  // covered in dormancy.test.ts and dormancy-store.test.ts.
  status: "active", lastRaiseAt: now, dormantSince: null, serverLastEventAt: now, ...o,
});

const fakeStore = (clocks: FactionClockRow[], over: Partial<DormancyStore> = {}): DormancyStore => ({
  clocks: async () => clocks,
  goDormant: async () => true,
  revive: async () => true,
  stampDormantSince: async () => true,
  disbandDormant: async () => true,
  ...over,
});

describe("dormancyTick", () => {
  it("makes a stale active faction dormant and returns a notice", async () => {
    const goDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) })], { goDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(goDormant).toHaveBeenCalledWith(1, now);
    expect(r.dormant).toBe(1);
    expect(r.notices).toEqual([{
      kind: "dormant", factionId: 1, leaderDiscordId: "d1", name: "Bears", tag: "BEAR",
      dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
      disbandAt: new Date(now.getTime() + DEFAULT_DISBAND_AFTER_DORMANT_MS),
    }]);
  });

  it("⚠️ emits no notice when the transition did not happen", async () => {
    // The guarded update returning false means another tick got there first.
    // Notifying anyway is how a leader gets the same warning twice.
    const store = fakeStore([row({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) })], {
      goDormant: async () => false,
    });
    const r = await dormancyTick(store, { now, windows });
    expect(r.dormant).toBe(0);
    expect(r.notices).toEqual([]);
  });

  it("revives a dormant faction whose flag flew again", async () => {
    const revive = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({ status: "dormant", lastRaiseAt: ago(10), dormantSince: ago(99999) })], { revive });

    const r = await dormancyTick(store, { now, windows });
    expect(revive).toHaveBeenCalledWith(1);
    expect(r.revived).toBe(1);
    expect(r.notices[0]!.kind).toBe("revive");
    // ⚠️ disbandAt is meaningless for a revive — the faction is no longer
    // dormant, so nothing is counting down. Omitted, not populated with a
    // number nobody should read.
    expect(r.notices[0]!.disbandAt).toBeUndefined();
  });

  it("⚠️ revives rather than disbands a faction that raised its flag on day 20", async () => {
    const revive = vi.fn().mockResolvedValue(true);
    const disbandDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(10),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS + 86_400_000),
    })], { revive, disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(revive).toHaveBeenCalled();
    expect(disbandDormant).not.toHaveBeenCalled();
    expect(r.disbanded).toBe(0);
  });

  it("disbands a faction dormant past the window, with no notice", async () => {
    // There is nobody to tell: the faction no longer exists, and its roster
    // has been cleared by the same transaction.
    const disbandDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 5),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
    })], { disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(disbandDormant).toHaveBeenCalledWith(1, new Date(now.getTime() - DEFAULT_DISBAND_AFTER_DORMANT_MS));
    expect(r.disbanded).toBe(1);
    expect(r.notices).toEqual([]);
  });

  it("stamps a dormant row with no timestamp instead of disbanding it", async () => {
    const stampDormantSince = vi.fn().mockResolvedValue(true);
    const disbandDormant = vi.fn();
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 9), dormantSince: null,
    })], { stampDormantSince, disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(stampDormantSince).toHaveBeenCalledWith(1, now);
    expect(disbandDormant).not.toHaveBeenCalled();
    expect(r.stamped).toBe(1);
  });

  it("⚠️ one faction's failure does not cost the others their tick", async () => {
    // A per-faction throw must not abort the sweep: the second faction's
    // supplies depend on its status changing.
    const goDormant = vi.fn()
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce(true);
    const store = fakeStore([
      row({ id: 1, tag: "AAA", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }),
      row({ id: 2, tag: "BBB", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }),
    ], { goDormant });
    const onError = vi.fn();

    const r = await dormancyTick(store, { now, windows, onError });
    expect(r.dormant).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.examined).toBe(2);
  });

  it("counts what it looked at even when nothing changes", async () => {
    const r = await dormancyTick(fakeStore([row({}), row({ id: 2 })]), { now, windows });
    expect(r).toMatchObject({ examined: 2, dormant: 0, revived: 0, disbanded: 0, stamped: 0 });
  });
});
