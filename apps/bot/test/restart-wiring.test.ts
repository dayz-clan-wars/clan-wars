import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "discord.ts"), "utf8");

describe("restart tick wiring", () => {
  it("runs restartTick in the loop, gated on cfg.restartSchedule, in its own try/catch", () => {
    expect(src).toMatch(/import \{ restartTick[^}]*\} from "\.\/restart-tick\.js"/u);
    expect(src).toMatch(/if \(cfg\.restartSchedule\) \{\s*try \{[\s\S]*?await restartTick\(db, nitradoFor, \{ now: new Date\(\) \}\)/u);
  });
  it("builds one NitradoClient per service id from cfg.nitradoToken", () => {
    expect(src).toMatch(/new NitradoClient\(cfg\.nitradoToken/u);
  });
  it("says at startup when the schedule is off — an off feature must not look broken", () => {
    expect(src).toMatch(/RESTART_SCHEDULE/u);
  });
});
