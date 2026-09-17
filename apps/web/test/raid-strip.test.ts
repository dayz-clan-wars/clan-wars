import { describe, it, expect } from "vitest";
import { raidStripLine } from "@/lib/raid-strip";

const FRI = new Date("2026-09-18T00:00:00.000Z");
const MON = new Date("2026-09-21T00:00:00.000Z");

describe("raidStripLine", () => {
  it("live, with time until close", () => {
    const l = raidStripLine({ status: "live", opensAt: FRI, closesAt: MON }, new Date("2026-09-20T10:00:00.000Z"));
    expect(l.label).toBe("RAID WEEKEND");
    expect(l.value).toBe("LIVE");
    expect(l.detail).toBe("closes in 14h");
    expect(l.tone).toBe("live");
  });

  it("closed, with time until open", () => {
    const l = raidStripLine({ status: "closed", opensAt: FRI, closesAt: MON }, new Date("2026-09-16T00:00:00.000Z"));
    expect(l.value).toBe("CLOSED");
    expect(l.detail).toBe("opens in 2d 0h");
    expect(l.tone).toBe("muted");
  });

  it("⚠️ unconfirmed never reads as live", () => {
    const l = raidStripLine({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON }, FRI);
    expect(l.value).toBe("OPENING");
    expect(l.detail).toBe("not yet confirmed");
    expect(l.tone).toBe("warn");
  });

  // ⚠️ An unconfirmed CLOSE leaves base damage ON. "OPENING" there is the wrong
  // word in the reassuring direction, which is the direction this design never
  // takes; it must name the flip that has not happened.
  it("⚠️ an unconfirmed close reads as CLOSING, not OPENING", () => {
    const l = raidStripLine({ status: "unconfirmed", pending: "close", opensAt: FRI, closesAt: MON }, MON);
    expect(l.value).toBe("CLOSING");
    expect(l.detail).toBe("not yet confirmed");
    expect(l.tone).toBe("warn");
  });

  it("skipped shows the reason", () => {
    const l = raidStripLine(
      { status: "skipped", opensAt: FRI, closesAt: MON, skipReason: "launch weekend" },
      new Date("2026-09-16T00:00:00.000Z"),
    );
    expect(l.value).toBe("SKIPPED THIS WEEK");
    expect(l.detail).toBe("launch weekend");
    expect(l.tone).toBe("muted");
  });
});
