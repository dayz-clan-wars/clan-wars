import { describe, it, expect } from "vitest";
import { formatSequence } from "../src/commands.js";

describe("formatSequence", () => {
  it("renders human labels, numbered, not raw tokens", () => {
    const out = formatSequence(["EmoteSalute", "EmoteClap"]);
    expect(out).toContain("salute");
    expect(out).toContain("clap");
    expect(out).not.toContain("EmoteSalute");
    expect(out).toContain("1.");
    expect(out).toContain("2.");
  });
});
