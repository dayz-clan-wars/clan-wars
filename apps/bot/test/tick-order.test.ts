import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "discord.ts"), "utf8");

describe("enforcement tick wiring (task 10)", () => {
  it("imports violationTick and banTick", () => {
    expect(src).toMatch(/import \{ violationTick \} from "\.\/violation-tick\.js"/u);
    expect(src).toMatch(/import \{ banTick \} from "\.\/ban-tick\.js"/u);
  });

  it("runs violationTick after zoneTick and before the posters (feedTick, noticeTick)", () => {
    const zoneAt = src.indexOf("await zoneTick(db,");
    const violationAt = src.indexOf("await violationTick(db,");
    const feedAt = src.indexOf("await feedTick(feedStore,");
    const noticeAt = src.indexOf("await noticeTick(");
    expect(zoneAt).toBeGreaterThan(-1);
    expect(violationAt).toBeGreaterThan(-1);
    expect(feedAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(-1);
    // Closes what zoneTick opens.
    expect(violationAt).toBeGreaterThan(zoneAt);
    // A warning queued this tick must be posted this tick.
    expect(violationAt).toBeLessThan(feedAt);
    expect(violationAt).toBeLessThan(noticeAt);
  });

  it("gates violationTick on cfg.enforcementTick", () => {
    expect(src).toMatch(/if \(cfg\.enforcementTick\) \{\s*try \{\s*const v = await violationTick\(db,/u);
  });

  it("runs banTick beside reaperTick, inside the REAPER_INTERVAL_MS block, NOT in the every-tick section", () => {
    const reaperIntervalCheck = src.indexOf("Date.now() - lastReaperAt >= REAPER_INTERVAL_MS");
    const reaperAt = src.indexOf("await reaperTick(db,");
    const banAt = src.indexOf("await banTick(db,");
    const violationAt = src.indexOf("await violationTick(db,");
    expect(reaperIntervalCheck).toBeGreaterThan(-1);
    expect(reaperAt).toBeGreaterThan(reaperIntervalCheck);
    expect(banAt).toBeGreaterThan(reaperAt);
    // banTick runs strictly after the every-tick violationTick call, i.e. it
    // is not accidentally in the every-tick block above the reaper gate.
    expect(banAt).toBeGreaterThan(violationAt);
  });

  it("gates banTick on cfg.enforcementTick and passes a server-scoped NitradoClient via nitradoFor", () => {
    expect(src).toMatch(/if \(cfg\.enforcementTick\) \{[\s\S]{0,600}?await banTick\(db, nitradoFor\(s\.serviceId!\), \{[\s\S]{0,200}?serverId: s\.id/u);
  });

  it("bounds banTick's since by BAN_APPLY_LOOKBACK_MS from now, not process start time", () => {
    expect(src).toMatch(/BAN_APPLY_LOOKBACK_MS/u);
    expect(src).toMatch(/since = new Date\(banNow\.getTime\(\) - BAN_APPLY_LOOKBACK_MS\)/u);
  });
});

describe("King of the Hill vote and decision wiring (spec 2026-09-24 §6.5)", () => {
  it("runs the vote tick, then the automatic decision, then the airdrop decision, all after the restart tick", () => {
    const restartAt = src.indexOf("await restartTick(db,");
    const voteAt = src.indexOf("await kothVoteTick(db,");
    const decideAt = src.indexOf("await kothDecideTick(db,");
    const airdropAt = src.indexOf("await airdropTick(db,");
    for (const i of [restartAt, voteAt, decideAt, airdropAt]) expect(i).toBeGreaterThan(-1);
    expect(voteAt).toBeGreaterThan(restartAt);
    // ⚠️ The airdrop yields to a scheduled KotH row only if the row exists when it looks.
    expect(decideAt).toBeGreaterThan(voteAt);
    expect(airdropAt).toBeGreaterThan(decideAt);
  });
  it("gates the decision on cfg.koth.auto.enabled", () => {
    expect(src).toMatch(/if \(cfg\.koth\.auto\.enabled\) \{\s*try \{\s*const d = await kothDecideTick\(db,/u);
  });
  // ⚠️ Not gated on KOTH_VOTE: an open vote must still close when the flag goes off.
  it("runs the vote tick whenever the channel exists", () => {
    expect(src).toMatch(/if \(kothVoteChannel\) \{\s*try \{\s*const v = await kothVoteTick\(db,/u);
  });
});
