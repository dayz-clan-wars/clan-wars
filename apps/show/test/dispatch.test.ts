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
});
