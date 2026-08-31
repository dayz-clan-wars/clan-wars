import { describe, it, expect } from "vitest";
import { poleKey, parsePoleKey } from "../src/index.js";

describe("poleKey", () => {
  it("rounds to 1cm and joins with colons", () => {
    expect(poleKey({ x: 2991.569092, y: 447.946503, z: 1138.587646 })).toBe("2991.57:447.95:1138.59");
  });

  it("is stable across float noise below 1cm", () => {
    const a = poleKey({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
    const b = poleKey({ x: 2991.5691, y: 447.9465, z: 1138.5876 });
    expect(a).toBe(b);
  });

  it("distinguishes poles more than 1cm apart", () => {
    const a = poleKey({ x: 2991.57, y: 447.95, z: 1138.59 });
    const b = poleKey({ x: 2991.59, y: 447.95, z: 1138.59 });
    expect(a).not.toBe(b);
  });

  it("always emits two decimal places", () => {
    expect(poleKey({ x: 100, y: 0, z: -5.1 })).toBe("100.00:0.00:-5.10");
  });

  it("normalizes negative zero across the zero boundary", () => {
    const a = poleKey({ x: 0.001, y: 0, z: 0 });
    const b = poleKey({ x: -0.001, y: 0, z: 0 });
    expect(a).toBe(b);
    expect(a).toBe("0.00:0.00:0.00");
  });
});

describe("parsePoleKey", () => {
  it("round-trips through poleKey", () => {
    const key = poleKey({ x: 2991.57, y: 447.95, z: 1138.59 });
    expect(parsePoleKey(key)).toEqual({ x: 2991.57, y: 447.95, z: 1138.59 });
  });

  it("round-trips a negative coordinate", () => {
    const key = poleKey({ x: 100, y: 0, z: -5.1 });
    expect(parsePoleKey(key)).toEqual({ x: 100, y: 0, z: -5.1 });
  });

  it("returns null for too few parts", () => {
    expect(parsePoleKey("1.00:2.00")).toBeNull();
  });

  it("returns null for too many parts", () => {
    expect(parsePoleKey("1.00:2.00:3.00:4.00")).toBeNull();
  });

  it("returns null for a non-numeric part", () => {
    expect(parsePoleKey("1.00:abc:3.00")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parsePoleKey("")).toBeNull();
  });

  it("parses a real number surrounded by whitespace", () => {
    // Harmless: whitespace around a genuine numeric token carries no risk of
    // misreading corruption as a coordinate.
    expect(parsePoleKey("1: 2 :3")).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("returns null for three empty parts, rather than treating them as zero", () => {
    // Number("") is 0, so a naive Number()+isFinite check turns a fully
    // corrupted key into a plausible-looking origin-point ceremony — worse
    // than refusing, because it looks like real data.
    expect(parsePoleKey("::")).toBeNull();
  });

  it("returns null for three whitespace-only parts", () => {
    // Same danger as "::" — Number(" ") is also 0.
    expect(parsePoleKey(" : : ")).toBeNull();
  });

  it("returns null when one part among otherwise-valid parts is empty", () => {
    // The dangerous case the earlier malformed-shape tests didn't cover: a
    // key that is well-formed at the ":"-count level but has a silently
    // zeroed coordinate hiding inside it.
    expect(parsePoleKey("1::3")).toBeNull();
  });

  it("returns null for a hex-formatted part", () => {
    // poleKey() never emits hex; accepting "0x10" as 16 means accepting a
    // key this system did not write, silently reinterpreted as a different
    // number than its digits suggest.
    expect(parsePoleKey("0x10:2:3")).toBeNull();
  });

  it("returns null for a scientific-notation part", () => {
    // poleKey() never emits scientific notation either; accepting it widens
    // what counts as a valid key beyond what this system can produce.
    expect(parsePoleKey("1e5:2:3")).toBeNull();
  });
});
