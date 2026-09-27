import { describe, it, expect } from "vitest";
import { referralWeekFor, previousReferralWeek, qualifiedAt, referralWinners, REFERRAL_QUALIFY_MS } from "../src/index";

const at = (iso: string) => new Date(iso);
const H = 3_600_000;

describe("referralWeekFor", () => {
  it("runs Monday 10:00 UTC to the next Monday 10:00 UTC", () => {
    expect(referralWeekFor(at("2026-09-30T12:00:00Z"))).toEqual({ start: at("2026-09-28T10:00:00Z"), end: at("2026-10-05T10:00:00Z") });
  });
  it("puts Monday 09:59 in the previous week and Monday 10:00 in the new one", () => {
    expect(referralWeekFor(at("2026-09-28T09:59:59Z")).start).toEqual(at("2026-09-21T10:00:00Z"));
    expect(referralWeekFor(at("2026-09-28T10:00:00Z")).start).toEqual(at("2026-09-28T10:00:00Z"));
  });
  it("treats Sunday as the end of the week, not the start", () => {
    expect(referralWeekFor(at("2026-10-04T23:00:00Z")).start).toEqual(at("2026-09-28T10:00:00Z"));
  });
  it("is unaffected by a European DST change (UTC throughout)", () => {
    expect(referralWeekFor(at("2026-10-26T10:00:00Z")).start).toEqual(at("2026-10-26T10:00:00Z"));
  });
  it("previousReferralWeek is the week that most recently ended", () => {
    expect(previousReferralWeek(at("2026-09-28T10:00:00Z"))).toEqual({ start: at("2026-09-21T10:00:00Z"), end: at("2026-09-28T10:00:00Z") });
  });
});

describe("qualifiedAt", () => {
  const s = (from: string, to: string | null) => ({ connectedAt: at(from), disconnectedAt: to === null ? null : at(to) });
  const now = at("2026-10-01T00:00:00Z");

  it("is null below two hours", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T11:59:00Z")], at("2026-09-29T00:00:00Z"), now)).toBeNull();
  });
  it("is the instant cumulative play reaches two hours, across sessions", () => {
    const sessions = [s("2026-09-29T20:00:00Z", "2026-09-29T21:30:00Z"), s("2026-09-28T10:00:00Z", "2026-09-28T10:10:00Z"), s("2026-09-30T08:00:00Z", "2026-09-30T09:00:00Z")];
    // 10 min + 90 min = 100 min; 20 more minutes into the third session.
    expect(qualifiedAt(sessions, at("2026-09-28T00:00:00Z"), now)).toEqual(at("2026-09-30T08:20:00Z"));
  });
  it("counts an open session up to now, and lands mid-session across the week boundary", () => {
    const sessions = [s("2026-10-05T09:00:00Z", null)];
    expect(qualifiedAt(sessions, at("2026-10-01T00:00:00Z"), at("2026-10-05T12:00:00Z"))).toEqual(at("2026-10-05T11:00:00Z"));
    expect(qualifiedAt(sessions, at("2026-10-01T00:00:00Z"), at("2026-10-05T10:30:00Z"))).toBeNull();
  });
  it("uses the referral instant for a player who already had the play time", () => {
    expect(qualifiedAt([s("2026-01-01T00:00:00Z", "2026-01-01T05:00:00Z")], at("2026-09-29T15:00:00Z"), now)).toEqual(at("2026-09-29T15:00:00Z"));
  });
  it("ignores a zero or negative span", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T09:00:00Z")], at("2026-09-01T00:00:00Z"), now)).toBeNull();
  });
  it("honours needMs", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T10:30:00Z")], at("2026-09-01T00:00:00Z"), now, H / 2)).toEqual(at("2026-09-29T10:30:00Z"));
    expect(REFERRAL_QUALIFY_MS).toBe(2 * H);
  });
});

describe("referralWinners", () => {
  const linked = (...ids: string[]) => (id: string) => ids.includes(id);
  it("is every linked referrer tied at the top", () => {
    expect(referralWinners([{ discordId: "a", count: 3 }, { discordId: "b", count: 3 }, { discordId: "c", count: 1 }], linked("a", "b", "c")))
      .toEqual({ winners: ["a", "b"], topCount: 3, skipped: [] });
  });
  it("skips an unlinked top referrer and gives it to the next", () => {
    expect(referralWinners([{ discordId: "x", count: 5 }, { discordId: "b", count: 2 }], linked("b")))
      .toEqual({ winners: ["b"], topCount: 2, skipped: ["x"] });
  });
  it("has no winner with no counts, or nobody linked", () => {
    expect(referralWinners([], linked())).toEqual({ winners: [], topCount: 0, skipped: [] });
    expect(referralWinners([{ discordId: "x", count: 1 }], linked())).toEqual({ winners: [], topCount: 0, skipped: ["x"] });
  });
  it("lists winners and skipped in a stable order", () => {
    expect(referralWinners([{ discordId: "b", count: 1 }, { discordId: "a", count: 1 }], linked("a", "b")).winners).toEqual(["a", "b"]);
  });
});
