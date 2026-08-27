import { describe, it, expect } from "vitest";
import { poleKey } from "../src/index.js";

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
