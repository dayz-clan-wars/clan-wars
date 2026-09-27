import { describe, it, expect } from "vitest";
import { REFERRAL_WEEK_START_HOUR_UTC } from "@factions/domain";
import { REFERRAL_COPY, REFERRAL_RECORDED, REFERRER_UNNAMED, REFERRERS_WEEK_NOTE, boardHeading } from "../src/index";
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

describe("REFERRER_UNNAMED", () => {
  it("is plain words, no em dash", () => {
    expect(REFERRER_UNNAMED).toBe("a player no longer linked");
    expect(REFERRER_UNNAMED).not.toContain("—");
  });
});

// ⚠️ Two statements of one fact: the note names the hour the contest week starts,
// so it is built from the constant the week itself is (`referralWeekFor`).
describe("REFERRERS_WEEK_NOTE", () => {
  it("names the week's start hour from REFERRAL_WEEK_START_HOUR_UTC", () => {
    expect(REFERRERS_WEEK_NOTE).toBe(`This week, from Monday ${String(REFERRAL_WEEK_START_HOUR_UTC).padStart(2, "0")}:00 UTC`);
  });
  it("has no em dash", () => {
    expect(REFERRERS_WEEK_NOTE).not.toContain("—");
  });
});

describe("boardHeading", () => {
  it("is the week note for the weekly referrers board, whatever the scope", () => {
    expect(boardHeading("referrersWeek", { kind: "season", number: 2 })).toBe(REFERRERS_WEEK_NOTE);
    expect(boardHeading("referrersWeek", { kind: "all" })).toBe(REFERRERS_WEEK_NOTE);
  });
  it("is the scope label for every other board", () => {
    expect(boardHeading("referrers", { kind: "season", number: 2 })).toBe("Season 2");
    expect(boardHeading("killers", { kind: "all" })).toBe("All-time");
  });
});
