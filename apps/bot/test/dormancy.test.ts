import { describe, it, expect } from "vitest";
import {
  decide, DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS,
  type FactionClock,
} from "../src/dormancy.js";

const W = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const clock = (o: Partial<FactionClock>): FactionClock =>
  // serverLastEventAt defaults to "now" — live — so every existing test that
  // doesn't care about server liveness keeps exercising the branch it always
  // did rather than tripping the new gate by accident.
  ({ status: "active", lastRaiseAt: now, dormantSince: null, serverLastEventAt: now, ...o });

describe("decide", () => {
  it("leaves an active faction alone while its flag is fresh", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS - 1) }), now, W)).toBeNull();
  });

  it("goes dormant exactly at the window", () => {
    // The server's FlagRefreshMaxDuration is 7 days; at 7 days the base is
    // already decaying, so the boundary belongs to dormancy.
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W)).toBe("dormant");
  });

  it("goes dormant past the window", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }), now, W)).toBe("dormant");
  });

  it("revives a dormant faction whose flag flew again", () => {
    expect(decide(clock({ status: "dormant", lastRaiseAt: ago(1000), dormantSince: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W))
      .toBe("revive");
  });

  it("⚠️ revives rather than disbands when both would apply", () => {
    // A faction that raises its flag on day 20 of dormancy must be rescued by
    // the same tick that could have disbanded it. The loss is irreversible, so
    // the outcome must not depend on tick timing.
    expect(decide(clock({
      status: "dormant",
      lastRaiseAt: ago(1000),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS + 86_400_000),
    }), now, W)).toBe("revive");
  });

  it("holds a dormant faction that is not yet due to disband", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS - 1),
    }), now, W)).toBeNull();
  });

  it("disbands exactly at the dormant window", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 3),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
    }), now, W)).toBe("disband");
  });

  it("⚠️ never disbands a dormant faction with no dormant_since — it stamps one", () => {
    // Reachable only if something outside this tick set the status. Losing a
    // flag to a missing timestamp is not acceptable; waiting another 14 days is.
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10), dormantSince: null,
    }), now, W)).toBe("stamp");
  });

  it("ignores reserved and disbanded factions entirely", () => {
    for (const status of ["reserved", "disbanded", "lapsed"]) {
      expect(decide(clock({ status, lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10) }), now, W)).toBeNull();
    }
  });

  it("treats a faction with no raise at all as stale", () => {
    // The store coalesces to activated_at/created_at, so null should not occur
    // — but a null that reached here must not read as 'fresh'.
    expect(decide(clock({ lastRaiseAt: null }), now, W)).toBe("dormant");
  });

  describe("the disband liveness gate", () => {
    // A faction due to disband, held constant across these three cases —
    // only serverLastEventAt moves.
    const due = (serverLastEventAt: Date | null) => clock({
      status: "dormant",
      lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 5),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
      serverLastEventAt,
    });

    it("⚠️ a stale server disbands nothing, even a faction that is otherwise due", () => {
      // If the server itself has produced no event in dormantAfterMs, ingest
      // is presumably down and every faction on it reads as falsely stale.
      //
      // ⚠️ This used to return null — a silent refusal. It now returns
      // "pause", which both withholds the disband AND stops the clock
      // accruing time nobody was watching. See "the paused disband clock".
      expect(decide(due(ago(DEFAULT_DORMANT_AFTER_MS + 1)), now, W)).toBe("pause");
    });

    it("a live server still disbands a faction that is due", () => {
      expect(decide(due(ago(1000)), now, W)).toBe("disband");
    });

    it("no server events at all (null) disbands nothing", () => {
      // Fresh ingest, or a worker that has never run for this server: every
      // faction on it must read as un-observed, not as abandoned.
      expect(decide(due(null), now, W)).toBe("pause");
    });

    it("disbands exactly at the server-liveness boundary", () => {
      // Matches `fresh`'s own boundary convention: an event exactly
      // dormantAfterMs old no longer counts as live.
      expect(decide(due(ago(DEFAULT_DORMANT_AFTER_MS)), now, W)).toBe("pause");
      expect(decide(due(ago(DEFAULT_DORMANT_AFTER_MS - 1)), now, W)).toBe("disband");
    });

    it("does not gate 'dormant' or 'revive' — only disband needs a live server", () => {
      // Going dormant is reversible and only cuts supplies, so it must not
      // wait on ingest health the way the irreversible step does.
      expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1), serverLastEventAt: null }), now, W))
        .toBe("dormant");
      expect(decide(clock({
        status: "dormant", lastRaiseAt: ago(10), dormantSince: ago(99999), serverLastEventAt: null,
      }), now, W)).toBe("revive");
    });
  });

  describe("the paused disband clock", () => {
    const DAY = 86_400_000;

    it("pauses a dormant faction's clock while its server is dark, even when not yet due", () => {
      // The clock measures OBSERVED silence. A tick that cannot see the server
      // has observed nothing, so it must not let the clock advance — whether
      // or not the row happens to be due yet.
      expect(decide(clock({
        status: "dormant",
        lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
        dormantSince: ago(DAY),
        serverLastEventAt: ago(DEFAULT_DORMANT_AFTER_MS + 1),
      }), now, W)).toBe("pause");
    });

    it("does not pause while the server is live", () => {
      expect(decide(clock({
        status: "dormant",
        lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
        dormantSince: ago(DAY),
        serverLastEventAt: ago(1000),
      }), now, W)).toBeNull();
    });

    it("⚠️ revive still beats pause", () => {
      // A raise is evidence. A dark server is the absence of evidence. If we
      // somehow have the former, it wins — the same reasoning that puts revive
      // ahead of disband.
      expect(decide(clock({
        status: "dormant",
        lastRaiseAt: ago(1000),
        dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
        serverLastEventAt: null,
      }), now, W)).toBe("revive");
    });

    it("stamp still beats pause on a dormant row with no timestamp", () => {
      // Both write dormant_since = now, but the store guards differ (IS NULL
      // versus IS NOT NULL), so the tick must pick the one that will match.
      expect(decide(clock({
        status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
        dormantSince: null, serverLastEventAt: null,
      }), now, W)).toBe("stamp");
    });

    it("⚠️ the inbox-26 outage: a faction is not disbanded on 11 days of proven silence", () => {
      // The scenario, replayed one tick per day. Ingest is down days 0-20 and
      // backfills on day 20. The faction genuinely raised its flag on day 10,
      // which nothing could observe until the backfill landed.
      //
      // Before the pause, dormant_since was stamped on day 7 from evidence
      // that did not exist yet, kept ageing through the blind window, and the
      // faction disbanded on day 21 — 14 days after a stamp backed by only 11
      // days of anything anyone actually watched.
      const t0 = new Date("2026-01-01T00:00:00Z");
      const at = (day: number) => new Date(t0.getTime() + day * DAY);

      let status = "active";
      let dormantSince: Date | null = null;
      let disbandedOn: number | null = null;

      for (let day = 0; day <= 40 && disbandedOn === null; day++) {
        const t = at(day);
        // What the log can show us on this day. While ingest is down the
        // newest event stays at day 0; from the backfill onwards the server is
        // ingesting normally again, so its newest event tracks the present.
        const serverLastEventAt = day < 20 ? at(0) : t;
        // The faction's own last raise, as far as the ingested log knows. Its
        // real day-10 raise is invisible until the backfill lands.
        const lastRaiseAt = day < 20 ? at(0) : at(10);

        switch (decide({ status, lastRaiseAt, dormantSince, serverLastEventAt }, t, W)) {
          case "dormant": status = "dormant"; dormantSince = t; break;
          case "revive": status = "active"; dormantSince = null; break;
          case "stamp": case "pause": dormantSince = t; break;
          case "disband": disbandedOn = day; break;
          case null: break;
        }
      }

      // It still disbands — the faction really did go quiet — but only after a
      // full 14 days measured from the last tick that could see nothing.
      // Dormant on day 7, paused each day through day 19, ingest back on day
      // 20, so the countdown runs from day 19: 19 + 14 = 33.
      expect(disbandedOn).toBe(33);
      // The property that matters, stated independently of the arithmetic:
      // strictly more than the 21 the old behaviour produced, and at least a
      // full window after observation resumed on day 20.
      expect(disbandedOn! - 20).toBeGreaterThanOrEqual(
        DEFAULT_DISBAND_AFTER_DORMANT_MS / DAY - 1,
      );
    });

    it("a healthy server's clock is never paused, so disband still lands at 14 days", () => {
      // The control for the case above: same replay, ingest never down.
      const t0 = new Date("2026-01-01T00:00:00Z");
      const at = (day: number) => new Date(t0.getTime() + day * DAY);

      let status = "active";
      let dormantSince: Date | null = null;
      let disbandedOn: number | null = null;

      for (let day = 0; day <= 40 && disbandedOn === null; day++) {
        const t = at(day);
        switch (decide({
          status, lastRaiseAt: at(0), dormantSince, serverLastEventAt: t,
        }, t, W)) {
          case "dormant": status = "dormant"; dormantSince = t; break;
          case "revive": status = "active"; dormantSince = null; break;
          case "stamp": case "pause": dormantSince = t; break;
          case "disband": disbandedOn = day; break;
          case null: break;
        }
      }

      // Dormant on day 7, disbanded 14 days later.
      expect(disbandedOn).toBe(21);
    });
  });
});
