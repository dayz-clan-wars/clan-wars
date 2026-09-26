import { describe, it, expect } from "vitest";
import { encodeMp3 } from "../../../src/engine/audio/encodeMp3.js";
import type { Run } from "../../../src/engine/run.js";

describe("encodeMp3", () => {
  it("returns the runner output bytes", async () => {
    const runImpl: Run = async () => Buffer.from([9, 8, 7]);
    const out = await encodeMp3(Buffer.from([1, 2]), { runImpl });
    expect([...out]).toEqual([9, 8, 7]);
  });

  it("throws when the runner produces no output", async () => {
    const runImpl: Run = async () => Buffer.alloc(0);
    await expect(encodeMp3(Buffer.from([1]), { runImpl })).rejects.toThrow(/no output/i);
  });
});
