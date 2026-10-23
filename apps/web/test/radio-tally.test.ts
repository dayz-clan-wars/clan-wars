import { describe, it, expect } from "vitest";
import { tally } from "@/lib/radio/tally";

const r = (digits: string) => ({ digits });

describe("tally", () => {
  it("stitches the recording's halves", () => {
    const cards = tally([r("????002049"), r("0910442410"), r("1001219970"), r("0281002?4?")]);
    expect(cards.map((c) => c.grid + c.key).sort()).toEqual(["0281002049", "0910442410", "1001219970"]);
    expect(cards.every((c) => !c.settled)).toBe(true); // one pass each
  });

  it("settles after two clean passes on a bunker grid", () => {
    const [c] = tally([r("0910442410"), r("0910442410")]);
    expect(c).toMatchObject({ grid: "091044", key: "2410", settled: true, isBunker: true, reads: 2 });
  });

  it("a disagreeing digit keeps it unsettled", () => {
    const [c] = tally([r("0910442410"), r("0910442410"), r("0910442411")]);
    expect(c!.digits[9]).toEqual({ value: "0", agree: 2, against: 1 });
    expect(c!.settled).toBe(false);
  });

  it("grid off the bunker list never settles", () => {
    expect(tally(Array.from({ length: 5 }, () => r("5555552410")))[0]!.settled).toBe(false);
  });

  it("noise reads never make a fourth card", () => {
    const reads = ["0910442410", "1001219970", "0281002049", "7777777777"].map(r);
    const cards = tally([...reads, ...reads.slice(0, 3)]);
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.grid).sort()).toEqual(["028100", "091044", "100121"]);
  });

  it("an unknown digit stays unknown", () => {
    const [c] = tally([r("09104424??")]);
    expect(c!.key).toBe("24??");
    expect(c!.digits[8]).toEqual({ value: null, agree: 0, against: 0 });
  });
});
