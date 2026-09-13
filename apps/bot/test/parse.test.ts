import { describe, it, expect } from "vitest";
import { parseScope } from "../src/commands/parse.js";

describe("parseScope", () => {
  it("defaults to the current season", () => {
    expect(parseScope(null)).toEqual({ kind: "current" });
    expect(parseScope("")).toEqual({ kind: "current" });
    expect(parseScope("current")).toEqual({ kind: "current" });
  });

  it("reads all-time and a season number", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    expect(parseScope("2")).toEqual({ kind: "season", number: 2 });
  });

  /** ⚠️ Anything else is the current season, not a throw: this parses a client-supplied string. */
  it("falls back to the current season for anything it does not recognise", () => {
    for (const raw of ["-1", "0", "1.5", "season two", "  "]) expect(parseScope(raw)).toEqual({ kind: "current" });
  });
});
