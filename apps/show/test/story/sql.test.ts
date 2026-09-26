import { describe, it, expect, afterEach } from "vitest";
import { whenLabel } from "../../src/story/sql.js";

describe("whenLabel", () => {
  const ORIG_TZ = process.env.TZ;
  afterEach(() => { process.env.TZ = ORIG_TZ; });

  it("renders the full English weekday, 24h time and UTC, regardless of process TZ", () => {
    expect(whenLabel(new Date("2026-09-24T16:33:57.000Z"))).toBe("Thursday 16:33 UTC");
    process.env.TZ = "America/Los_Angeles";
    expect(whenLabel(new Date("2026-09-24T16:33:57.000Z"))).toBe("Thursday 16:33 UTC");
  });

  it("accepts a string timestamp, same as iso() does", () => {
    expect(whenLabel("2026-09-25T00:05:00.000Z")).toBe("Friday 00:05 UTC");
  });
});
