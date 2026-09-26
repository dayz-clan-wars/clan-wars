import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const unit = (f: string) => fs.readFileSync(path.join(ROOT, "deploy", "systemd", f), "utf8");

describe("clan-wars-show units (spec §2.5, §14)", () => {
  it("is a low-priority oneshot under acab with the shared env file", () => {
    const s = unit("clan-wars-show.service");
    for (const line of ["Type=oneshot", "User=acab", "WorkingDirectory=/opt/clan-wars", "EnvironmentFile=/opt/clan-wars/.env", "Nice=10", "IOSchedulingClass=idle", "StateDirectory=clan-wars-show"]) {
      expect(s).toContain(line);
    }
    expect(s).toMatch(/^ExecStart=\/home\/acab\/\.local\/bin\/pnpm --filter @factions\/show start$/mu);
    expect(s).not.toMatch(/^Restart=/mu); // a failed run waits for the next timer tick
    // ⚠️ A hung run would hold the advisory lock forever; systemd kills it and the next tick retries.
    expect(s).toMatch(/^TimeoutStartSec=90min$/mu);
  });
  it("fires every 10 minutes and catches up after downtime", () => {
    const t = unit("clan-wars-show.timer");
    expect(t).toContain("OnCalendar=*:0/10");
    expect(t).toContain("Persistent=true");
  });
});
