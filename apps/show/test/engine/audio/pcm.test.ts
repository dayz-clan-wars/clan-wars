import { describe, it, expect } from "vitest";
import { trimSilencePcm } from "../../../src/engine/audio/pcm.js";

function pcmOf(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

describe("trimSilencePcm", () => {
  it("drops leading and trailing near-silent samples, keeps the loud span", () => {
    const trimmed = trimSilencePcm(pcmOf([0, 100, 9000, -8000, 50, 0]));
    expect(trimmed.length / 2).toBe(2);
    expect(trimmed.readInt16LE(0)).toBe(9000);
    expect(trimmed.readInt16LE(2)).toBe(-8000);
  });

  it("all-silence -> empty", () => {
    expect(trimSilencePcm(pcmOf([0, 100, -200, 0])).length).toBe(0);
  });
});
