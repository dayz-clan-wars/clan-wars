import { describe, expect, it } from "vitest";
import { compareSemver, selectNewestTag } from "../src/index";

describe("selectNewestTag", () => {
  it("orders numerically, not lexically", () => {
    // ⚠️ The whole reason this function exists. A string sort puts v1.9.0
    // above v1.10.0 and silently deploys the older release forever.
    expect(selectNewestTag(["v1.9.0", "v1.10.0"])).toBe("v1.10.0");
    expect(selectNewestTag(["v1.2.10", "v1.2.9"])).toBe("v1.2.10");
  });

  it("ignores tags that are not plain vX.Y.Z", () => {
    // Pre-releases and hand-made tags must never be deployed automatically.
    expect(selectNewestTag(["v1.0.0", "v2.0.0-rc1", "nightly", "v1.2"]))
      .toBe("v1.0.0");
  });

  it("returns null when nothing qualifies", () => {
    expect(selectNewestTag([])).toBeNull();
    expect(selectNewestTag(["nightly", "v1.2"])).toBeNull();
  });

  it("is indifferent to input order", () => {
    // Input arrives from `git tag`, whose order is not a promise.
    expect(selectNewestTag(["v0.1.0", "v1.10.0", "v1.9.0"])).toBe("v1.10.0");
    expect(selectNewestTag(["v1.10.0", "v0.1.0", "v1.9.0"])).toBe("v1.10.0");
  });

  it("compares major, then minor, then patch", () => {
    expect(compareSemver("v2.0.0", "v1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.0", "v1.1.99")).toBeGreaterThan(0);
    expect(compareSemver("v1.1.1", "v1.1.1")).toBe(0);
  });
});
