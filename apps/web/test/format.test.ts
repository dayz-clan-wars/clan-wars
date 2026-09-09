import { describe, it, expect } from "vitest";
import { ago, when } from "../lib/format";

describe("two clocks", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  it("ago is relative under a day and a bare date after", () => {
    expect(ago(new Date("2026-09-08T11:59:40Z"), now)).toBe("just now");
    expect(ago(new Date("2026-09-08T11:14:00Z"), now)).toBe("46 min ago");
    expect(ago(new Date("2026-09-08T09:00:00Z"), now)).toBe("3 h ago");
    expect(ago(new Date("2026-08-02T14:03:00Z"), now)).toBe("2 Aug");
  });
  it("when keeps the clock and says UTC", () => {
    expect(when(new Date("2026-09-13T21:40:00Z"))).toBe("13 Sept, 21:40 UTC");
  });
});
