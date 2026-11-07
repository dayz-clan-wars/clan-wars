import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_COPY } from "@factions/copy";

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

  it("runs the link gate per server before banTick, inside the enforcement block", () => {
    expect(src).toMatch(/for \(const s of banServers\) \{[\s\S]{0,400}?await runLinkGate\(s\.id, banNow\);[\s\S]{0,200}?await banTick\(/u);
  });

  it("⚠️ the link sweep is gated on LINK_TO_PLAY and confirms by REST before removing", () => {
    expect(src).toMatch(/if \(cfg\.linkToPlay !== "off" && membersFetched && [\s\S]{0,80}?LINK_SWEEP_INTERVAL_MS\) \{\s*try \{\s*const sw = await sweepMissedRemovals\(/u);
    expect(src).toMatch(/memberExists: \(id\) => guildGateway\.fetchMemberExists\(id\)/u);
  });

  it("⚠️ the link page's \"within 5 minutes\" is the ban block's interval", () => {
    // GATE_COPY["will-lift"] names the number; the link gate and banTick run
    // beside the reaper on REAPER_INTERVAL_MS. Change one, change both.
    const m = /const REAPER_INTERVAL_MS = (\d+) \* 60_000;/u.exec(src);
    expect(m).not.toBeNull();
    expect(GATE_COPY["will-lift"]("")).toContain(`within ${m![1]} minutes`);
  });

  it("bounds banTick's since by BAN_APPLY_LOOKBACK_MS from now, not process start time", () => {
    expect(src).toMatch(/BAN_APPLY_LOOKBACK_MS/u);
    expect(src).toMatch(/since = new Date\(banNow\.getTime\(\) - BAN_APPLY_LOOKBACK_MS\)/u);
  });
});

describe("King of the Hill vote and decision wiring (spec 2026-09-24 §6.5)", () => {
  it("runs the vote tick, then the automatic decision, after the restart tick", () => {
    const restartAt = src.indexOf("await restartTick(db,");
    const voteAt = src.indexOf("await kothVoteTick(db,");
    const decideAt = src.indexOf("await kothDecideTick(db,");
    for (const i of [restartAt, voteAt, decideAt]) expect(i).toBeGreaterThan(-1);
    expect(voteAt).toBeGreaterThan(restartAt);
    // ⚠️ A vote closing at T−30 must insert its row before the decision looks at the slot.
    expect(decideAt).toBeGreaterThan(voteAt);
  });
  it("gates the decision on cfg.koth.auto.enabled", () => {
    expect(src).toMatch(/if \(cfg\.koth\.auto\.enabled\) \{\s*try \{\s*const d = await kothDecideTick\(db,/u);
  });
  // ⚠️ Not gated on KOTH_VOTE: an open vote must still close when the flag goes off.
  it("runs the vote tick whenever the channel exists", () => {
    expect(src).toMatch(/if \(kothVoteChannel\) \{\s*try \{\s*const v = await kothVoteTick\(db,/u);
  });
});
