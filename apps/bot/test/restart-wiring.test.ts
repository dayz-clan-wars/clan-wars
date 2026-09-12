import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "discord.ts"), "utf8");

describe("restart tick wiring", () => {
  it("runs restartTick in the loop, gated on cfg.restartSchedule, in its own try/catch", () => {
    expect(src).toMatch(/import \{ restartTick[^}]*\} from "\.\/restart-tick\.js"/u);
    expect(src).toMatch(/if \(cfg\.restartSchedule\) \{\s*try \{[\s\S]*?await restartTick\(db, nitradoFor, \{ now: new Date\(\)/u);
  });
  // ⚠️ The wipe rides on the restart slots and is fired from nowhere else. Dropping
  // this argument leaves a configured TRUCK_WIPE_EVENTS silently doing nothing —
  // loadConfig would still accept it, and no log line would say the wipe was lost.
  it("passes cfg.truckWipe into the restart tick, the only thing that fires it", () => {
    expect(src).toMatch(/await restartTick\(db, nitradoFor, \{[^}]*truckWipe: cfg\.truckWipe/u);
  });
  it("runs the restart tick after the last Discord poster (noticeTick), not before", () => {
    const noticeAt = src.indexOf("await noticeTick(");
    const restartAt = src.indexOf("await restartTick(db, nitradoFor,");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(noticeAt);
  });
  it("builds one NitradoClient per service id from cfg.nitradoToken", () => {
    expect(src).toMatch(/new NitradoClient\(cfg\.nitradoToken/u);
  });
  it("says at startup when the schedule is off — an off feature must not look broken", () => {
    expect(src).toMatch(/RESTART_SCHEDULE is off: the bot is not restarting the server on a schedule\./u);
  });
});
