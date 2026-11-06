import { describe, it, expect, vi } from "vitest";
import { applyGameplay } from "../src/restart-tick.js";
import { RAID_WINDOW } from "@factions/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REAL = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");
const DAY = 86_400_000;
// The boundaries come from RAID_WINDOW, so a retimed window moves these
// fixtures with it instead of leaving them on a stale hour (they sat on
// 00:00 after the window moved to 14:00 once already).
/** The window's opening on the week of Fri 2026-09-18. */
const FRI = new Date(Date.UTC(2026, 8, 18 - 5 + RAID_WINDOW.openDow, RAID_WINDOW.openHour));
/** The close before it: the latest closeDow/closeHour instant before FRI. */
const PREV_CLOSE = (() => {
  const back = (FRI.getUTCDay() - RAID_WINDOW.closeDow + 7) % 7 || 7;
  const d = new Date(FRI.getTime() - back * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), RAID_WINDOW.closeHour));
})();
/** Midweek: closed, between PREV_CLOSE and FRI. */
const WED = new Date("2026-09-16T00:00:00.000Z");
/** Mid-weekend: halfway through the window, so inside it whatever its hours. */
const MID = new Date(FRI.getTime() + ((RAID_WINDOW.closeDow - RAID_WINDOW.openDow + 7) % 7 * DAY + (RAID_WINDOW.closeHour - RAID_WINDOW.openHour) * 3_600_000) / 2);

function target(content = REAL) {
  return {
    missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async (_path: string) => content),
    uploadFile: vi.fn(async (_dir: string, _name: string, _content: string) => undefined),
  };
}

describe("applyGameplay (raid window only)", () => {
  it("fixtures sit on the window's boundaries", () => {
    expect(FRI.toISOString()).toBe("2026-09-18T14:00:00.000Z"); // Fri 14:00 UTC today
    expect(FRI.getUTCDay()).toBe(RAID_WINDOW.openDow);
    expect(MID.getTime()).toBeGreaterThan(FRI.getTime());
  });

  it("opens the window at the Friday boundary and uploads once", async () => {
    const t = target();
    const out = await applyGameplay(t as never, FRI, { raidWindow: { skips: [] } });
    expect(out.flip!.changed).toBe(true);
    expect(out.flip!.wantedDisabled).toBe(false);
    expect(t.uploadFile).toHaveBeenCalledTimes(1);
    const [, name, body] = t.uploadFile.mock.calls[0]!;
    expect(name).toBe("cfggameplay.json");
    expect(JSON.parse(body as string).GeneralData.disableBaseDamage).toBe(false);
  });

  it("⚠️ never uploads when the file is already in the wanted state", async () => {
    // Midweek: the fixture already says disabled=true, which is correct.
    const t = target();
    const out = await applyGameplay(t as never, WED, { raidWindow: { skips: [] } });
    expect(out.flip!.changed).toBe(false);
    expect(t.downloadFile).toHaveBeenCalledTimes(1); // the download IS the check
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ level-triggered: repairs a hand-reverted file mid-weekend", async () => {
    // Mid-weekend, but someone put the file back to disabled=true.
    const t = target();
    const out = await applyGameplay(t as never, MID, { raidWindow: { skips: [] } });
    expect(out.flip!.changed).toBe(true);
    expect(out.flip!.wantedDisabled).toBe(false);
    // ⚠️ The boundary is the FRIDAY opening, not this slot.
    expect(out.flip!.boundaryAt.toISOString()).toBe(FRI.toISOString());
  });

  it("leaves base damage off for a skipped weekend", async () => {
    const t = target();
    const out = await applyGameplay(t as never, FRI, { raidWindow: { skips: [{ opensAt: FRI, reason: "launch" }] } });
    expect(out.flip!.wantedDisabled).toBe(true);
    expect(out.flip!.changed).toBe(false);
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ returns the previous content so a bad write can be undone", async () => {
    const t = target();
    const out = await applyGameplay(t as never, FRI, { raidWindow: { skips: [] } });
    expect(out.flip!.previousContent).toBe(REAL);
  });

  it("⚠️ refuses — and does NOT upload — when a guard rejects the edit", async () => {
    const t = target('{"GeneralData": {"disableContainerDamage": false}}');
    const out = await applyGameplay(t as never, FRI, { raidWindow: { skips: [] } });
    expect(out.flipError).toBeInstanceOf(Error);
    expect(out.flipError!.message).toMatch(/no "disableBaseDamage"/);
    expect(out.flip).toBeUndefined();
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ a midweek slot reports the close that ALREADY happened", async () => {
    const t = target();
    const out = await applyGameplay(t as never, WED, { raidWindow: { skips: [] } });
    // Wednesday sits after the weekend's close and before Friday's open. The flip
    // that put base damage off is the PREVIOUS close — the coming one has not
    // happened, so nothing could have recorded it, and the readers would find nothing.
    expect(out.flip!.boundaryAt.toISOString()).toBe(PREV_CLOSE.toISOString());
    expect(PREV_CLOSE.toISOString()).toBe("2026-09-13T14:00:00.000Z"); // Sun 14:00 UTC today
  });
});
