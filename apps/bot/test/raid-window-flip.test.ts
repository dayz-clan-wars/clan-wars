import { describe, it, expect, vi } from "vitest";
import { applyRaidWindow } from "../src/restart-tick.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REAL = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");
const FRI = new Date("2026-09-18T00:00:00.000Z");
const WED = new Date("2026-09-16T00:00:00.000Z");

function target(content = REAL) {
  return {
    missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async (_path: string) => content),
    uploadFile: vi.fn(async (_dir: string, _name: string, _content: string) => undefined),
  };
}

describe("applyRaidWindow", () => {
  it("opens the window at the Friday boundary and uploads once", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, []);
    expect(r.changed).toBe(true);
    expect(r.wantedDisabled).toBe(false);
    expect(t.uploadFile).toHaveBeenCalledTimes(1);
    const [, name, body] = t.uploadFile.mock.calls[0]!;
    expect(name).toBe("cfggameplay.json");
    expect(JSON.parse(body as string).GeneralData.disableBaseDamage).toBe(false);
  });

  it("⚠️ never uploads when the file is already in the wanted state", async () => {
    // Midweek: the fixture already says disabled=true, which is correct.
    const t = target();
    const r = await applyRaidWindow(t as never, WED, []);
    expect(r.changed).toBe(false);
    expect(t.downloadFile).toHaveBeenCalledTimes(1); // the download IS the check
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ level-triggered: repairs a hand-reverted file mid-weekend", async () => {
    // Saturday, but someone put the file back to disabled=true.
    const t = target();
    const r = await applyRaidWindow(t as never, new Date("2026-09-19T12:00:00.000Z"), []);
    expect(r.changed).toBe(true);
    expect(r.wantedDisabled).toBe(false);
    // ⚠️ The boundary is the FRIDAY, not Saturday's slot.
    expect(r.boundaryAt.toISOString()).toBe(FRI.toISOString());
  });

  it("leaves base damage off for a skipped weekend", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, [{ opensAt: FRI, reason: "launch" }]);
    expect(r.wantedDisabled).toBe(true);
    expect(r.changed).toBe(false);
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ returns the previous content so a bad write can be undone", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, []);
    expect(r.previousContent).toBe(REAL);
  });

  it("⚠️ refuses — and does NOT upload — when a guard rejects the edit", async () => {
    const t = target('{"GeneralData": {"disableContainerDamage": false}}');
    await expect(applyRaidWindow(t as never, FRI, [])).rejects.toThrow(/no "disableBaseDamage"/);
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ a midweek slot reports the close that ALREADY happened", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, WED, []);
    // Wednesday sits after Monday's close and before Friday's open. The flip that
    // put base damage off is the PREVIOUS Monday — the coming one has not happened,
    // so nothing could have recorded it, and the readers would find nothing.
    expect(r.boundaryAt.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
});
