import { describe, it, expect } from "vitest";
import { dispatch } from "../src/dispatch.js";

describe("dispatch", () => {
  it("plain run → service", () => {
    expect(dispatch({})).toEqual({ kind: "service" });
  });

  it("--dry-run → review", () => {
    expect(dispatch({ "dry-run": true })).toEqual({ kind: "review" });
  });

  it("--render dir → review", () => {
    expect(dispatch({ render: "/tmp" })).toEqual({ kind: "review" });
  });

  it("--print-prompt alone → usage", () => {
    const result = dispatch({ "print-prompt": true });
    expect(result).toEqual({ kind: "usage", message: expect.any(String) });
  });

  it("--render \"\" → usage", () => {
    const result = dispatch({ render: "" });
    expect(result).toEqual({ kind: "usage", message: expect.any(String) });
  });

  it("--dry-run --force → usage", () => {
    const result = dispatch({ "dry-run": true, force: true });
    expect(result).toEqual({ kind: "usage", message: expect.any(String) });
  });

  it("--render d --repost → usage", () => {
    const result = dispatch({ render: "/tmp", repost: true });
    expect(result).toEqual({ kind: "usage", message: expect.any(String) });
  });

  it("--week X --force → service", () => {
    expect(dispatch({ force: true })).toEqual({ kind: "service" });
  });

  it("--print-prompt --dry-run → review", () => {
    expect(dispatch({ "print-prompt": true, "dry-run": true })).toEqual({ kind: "review" });
  });

  it("--print-prompt --render dir → review", () => {
    expect(dispatch({ "print-prompt": true, render: "/tmp" })).toEqual({ kind: "review" });
  });

  describe("--special", () => {
    const usage = { kind: "usage", message: expect.any(String) };
    it("--special d --render o → special-render", () => {
      expect(dispatch({ special: "d", render: "o" })).toEqual({ kind: "special-render" });
    });
    it("--special d --publish o → special-publish", () => {
      expect(dispatch({ special: "d", publish: "o" })).toEqual({ kind: "special-publish" });
    });
    it("--special alone → usage", () => {
      expect(dispatch({ special: "d" })).toEqual(usage);
    });
    it("--special with both --render and --publish → usage", () => {
      expect(dispatch({ special: "d", render: "o", publish: "o" })).toEqual(usage);
    });
    it("--special with --week, --dry-run, --force or --repost → usage", () => {
      expect(dispatch({ special: "d", render: "o", week: "2026-10-12" })).toEqual(usage);
      expect(dispatch({ special: "d", render: "o", "dry-run": true })).toEqual(usage);
      expect(dispatch({ special: "d", publish: "o", force: true })).toEqual(usage);
      expect(dispatch({ special: "d", publish: "o", repost: true })).toEqual(usage);
    });
    it("--publish without --special → usage", () => {
      expect(dispatch({ publish: "o" })).toEqual(usage);
    });
    it("empty --special or --publish → usage", () => {
      expect(dispatch({ special: "", render: "o" })).toEqual(usage);
      expect(dispatch({ special: "d", publish: "" })).toEqual(usage);
    });
  });
});
