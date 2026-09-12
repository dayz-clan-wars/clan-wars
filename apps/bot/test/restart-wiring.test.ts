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
  // ⚠️ Same reason as the line above, and it matters more here: the wipe writes to a
  // file nobody looks at. Off and broken are indistinguishable from the journal unless
  // startup says which, and says WHICH events and window are live.
  it("says at startup whether the truck wipe is on, and with what window", () => {
    expect(src).toMatch(/TRUCK_WIPE_EVENTS is unset: the bot is not wiping trucks\./u);
    expect(src).toMatch(/truck wipe on:/u);
  });

  it("runs the announce tick in the loop, in its own try/catch", () => {
    expect(src).toMatch(/import \{ announceTick[^}]*\} from "\.\/announce-tick\.js"/u);
    // RULING (2026-09-12, task 6): the brief's original regex assumed the call fit on
    // one line; the brief's own Step 5 code spans several. This still pins both facts
    // the test exists to protect — announcePoster is passed, and offHour is shared
    // with the wipe window — without pinning whitespace.
    expect(src).toMatch(/await announceTick\(db, announcePoster, \{[\s\S]{0,160}?offHour: cfg\.truckWipe\.offHour/u);
  });

  // ⚠️ Same reason the wipe logs its own state: an unannounced wipe and a broken
  // announcer are indistinguishable from the journal otherwise.
  it("says at startup whether the rotation and the announcements channel are on", () => {
    expect(src).toMatch(/WEEKLY_VEHICLE_WIPE is off/u);
    expect(src).toMatch(/ANNOUNCEMENTS_CHANNEL_ID is unset/u);
  });
});
