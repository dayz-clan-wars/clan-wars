import { describe, it, expect } from "vitest";
import { REFERRAL_COPY, REFERRAL_RECORDED } from "../src/index";
import type { ReferrerRefusal } from "@factions/roster";

const REASONS: ReferrerRefusal[] = [
  "already-referred", "self", "referrer-not-linked", "unknown-referrer", "ambiguous-referrer", "loop", "not-linked",
];

describe("REFERRAL_COPY", () => {
  it.each(REASONS)("%s has no em dash, with or without a known referrer's gamertag", (reason) => {
    expect(REFERRAL_COPY[reason]({})).not.toContain("—");
    expect(REFERRAL_COPY[reason]({ referrerGamertag: "Otto" })).not.toContain("—");
  });

  it("covers exactly the ReferrerRefusal reasons", () => {
    expect(Object.keys(REFERRAL_COPY).sort()).toEqual([...REASONS].sort());
  });
});

describe("REFERRAL_RECORDED", () => {
  it("has no em dash and names the gamertag", () => {
    const s = REFERRAL_RECORDED("Otto");
    expect(s).toContain("Otto");
    expect(s).not.toContain("—");
  });
});
