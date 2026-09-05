import { describe, it, expect } from "vitest";
import { DECLARE_SOLO_REASONS } from "@factions/roster";
import { MIN_BASE_SPACING_M } from "@factions/domain";
import { DECLARE_COPY, RESULT_COPY, days } from "../lib/base-copy";

describe("base copy", () => {
  it("has a line for every declareSolo refusal", () => {
    for (const r of DECLARE_SOLO_REASONS) expect(DECLARE_COPY[r].length).toBeGreaterThan(10);
  });
  it("prints the spacing from rules.ts, not a literal", () => {
    expect(DECLARE_COPY["too-close"]).toContain(`${MIN_BASE_SPACING_M} m`);
  });
  it("covers the route handlers' own codes", () => {
    for (const code of ["declared", "released", "nothing", "unconfirmed"]) expect(RESULT_COPY[code]).toBeTruthy();
  });
  it("pluralises days", () => {
    expect(days(86_400_000)).toBe("1 day");
    expect(days(3 * 86_400_000)).toBe("3 days");
  });
});
