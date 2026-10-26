import { describe, it, expect } from "vitest";
import { wavOf } from "@/lib/radio/wav";

describe("wavOf", () => {
  it("writes a 16-bit mono WAV of every block, in order, clipped to full scale", () => {
    const v = new DataView(wavOf([Float32Array.of(0, 0.5), Float32Array.of(-1, 2)], 48_000));
    const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(at + i)));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(24, true)).toBe(48_000);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 16384, -32767, 32767]);
  });
});
