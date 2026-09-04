import { describe, it, expect } from "vitest";
import { safeNextPath, splitNextPath } from "../lib/auth/next-path";

describe("safeNextPath", () => {
  it("keeps an ordinary site-relative path", () => {
    expect(safeNextPath("/mobile")).toBe("/mobile");
    expect(safeNextPath("/link")).toBe("/link");
    expect(safeNextPath("/mobile?tab=map")).toBe("/mobile?tab=map");
  });

  it("falls back to / for nothing", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  // ⚠️ The whole point of this module. An unchecked ?next= turns the login
  // endpoint into an open redirect: a link to our own domain that lands the
  // player on someone else's, having just been asked to trust us.
  it("refuses absolute URLs", () => {
    expect(safeNextPath("https://evil.example/x")).toBe("/");
    expect(safeNextPath("http://evil.example")).toBe("/");
  });

  it("refuses protocol-relative URLs", () => {
    // Browsers read //evil.example as https://evil.example.
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("//evil.example/path")).toBe("/");
  });

  it("refuses backslash variants some browsers normalise to slashes", () => {
    expect(safeNextPath("\\\\evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });

  it("refuses anything not starting with a single slash", () => {
    expect(safeNextPath("mobile")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });

  it("refuses control characters that URL parsing strips before parsing", () => {
    expect(safeNextPath("/\t/evil.example")).toBe("/");
    expect(safeNextPath("/\n/evil.example")).toBe("/");
    expect(safeNextPath("/\r/evil.example")).toBe("/");
    expect(safeNextPath("/mobile ")).toBe("/");
  });

  // ⚠️ The backstop that does not depend on enumerating attacks. Whatever the
  // guard accepts must still resolve to OUR origin — enumerating bad prefixes
  // is how the tab bypass got through in the first place.
  it("resolves every accepted value to an on-site URL", () => {
    const base = "https://dayzclanwars.com";
    for (const probe of [
      "/mobile",
      "/mobile?tab=map",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "",
      "/a?b=1?c=2",
    ]) {
      expect(new URL(safeNextPath(probe), base).origin).toBe(base);
    }
  });
});

describe("splitNextPath", () => {
  it("splits a path with a query", () => {
    expect(splitNextPath("/mobile?tab=map")).toEqual({ pathname: "/mobile", search: "?tab=map" });
  });

  it("leaves search empty when there is no query", () => {
    expect(splitNextPath("/mobile")).toEqual({ pathname: "/mobile", search: "" });
  });

  it("re-validates, so an unsafe value cannot slip through the splitter", () => {
    expect(splitNextPath("https://evil.example/x")).toEqual({ pathname: "/", search: "" });
    expect(splitNextPath("//evil.example")).toEqual({ pathname: "/", search: "" });
    expect(splitNextPath(null)).toEqual({ pathname: "/", search: "" });
  });

  it("keeps everything after the first ? in the search", () => {
    expect(splitNextPath("/a?b=1?c=2")).toEqual({ pathname: "/a", search: "?b=1?c=2" });
  });
});
