import { describe, it, expect } from "vitest";
import { duration } from "../lib/scoring-copy";

describe("duration", () => {
  it("hours and minutes, no seconds", () => {
    expect(duration(11700)).toBe("3h 15m");
  });

  it("reads \"0m\" under a minute", () => {
    expect(duration(59)).toBe("0m");
  });

  it("drops the hours part entirely below one hour", () => {
    expect(duration(60)).toBe("1m");
    expect(duration(3599)).toBe("59m");
  });

  it("keeps a zero minutes part alongside hours", () => {
    expect(duration(3600)).toBe("1h 0m");
  });
});
