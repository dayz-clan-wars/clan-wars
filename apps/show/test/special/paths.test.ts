import { describe, it, expect } from "vitest";
import { fromInvocationDir } from "../../src/special/paths.js";

describe("fromInvocationDir", () => {
  it("resolves a relative path against the directory pnpm was run from, not apps/show", () => {
    expect(fromInvocationDir("apps/show/specials/x", { INIT_CWD: "/opt/clan-wars" }, "/opt/clan-wars/apps/show")).toBe("/opt/clan-wars/apps/show/specials/x");
  });
  it("leaves an absolute path alone", () => {
    expect(fromInvocationDir("/var/lib/x", { INIT_CWD: "/opt/clan-wars" }, "/elsewhere")).toBe("/var/lib/x");
  });
  it("falls back to the process cwd without INIT_CWD", () => {
    expect(fromInvocationDir("x", {}, "/here")).toBe("/here/x");
  });
});
