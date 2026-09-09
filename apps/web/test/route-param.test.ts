import { describe, it, expect } from "vitest";
import { decodeParam } from "../lib/route-param";

describe("decodeParam", () => {
  it("decodes a percent-encoded segment, so a gamertag with a space is looked up as typed", () => {
    expect(decodeParam("IGC%20slide")).toBe("IGC slide");
    expect(decodeParam("Hollow_Pt")).toBe("Hollow_Pt");
  });
  it("leaves malformed encoding alone rather than throwing", () => {
    expect(decodeParam("100%")).toBe("100%");
  });
});
