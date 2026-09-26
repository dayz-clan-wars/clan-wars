import { describe, it, expect, afterEach } from "vitest";
import { whenLabel } from "../../src/story/sql.js";

describe("whenLabel", () => {
  const ORIG_TZ = process.env.TZ;
  afterEach(() => { process.env.TZ = ORIG_TZ; });

  it("renders the full English weekday, a 12-hour time and UTC, regardless of process TZ", () => {
    expect(whenLabel(new Date("2026-09-24T16:33:57.000Z"))).toBe("Thursday 4:33 pm UTC");
    process.env.TZ = "America/Los_Angeles";
    expect(whenLabel(new Date("2026-09-24T16:33:57.000Z"))).toBe("Thursday 4:33 pm UTC");
  });

  it("noon is 12 pm and a morning time is am", () => {
    expect(whenLabel(new Date("2026-09-23T12:00:00Z"))).toBe("Wednesday 12:00 pm UTC");
    expect(whenLabel(new Date("2026-09-23T05:58:22Z"))).toBe("Wednesday 5:58 am UTC");
  });

  it("accepts a string timestamp, same as iso() does", () => {
    expect(whenLabel("2026-09-25T00:05:00.000Z")).toBe("Friday 12:05 am UTC");
  });
});
