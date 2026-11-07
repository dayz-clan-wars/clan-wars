import { describe, it, expect } from "vitest";
import { linkGateAction, unlinkedPlayMs, type LinkGateFacts } from "../src/link-gate";

const MINUTE = 60_000;
const from = new Date("2026-11-10T14:00:00Z");
const at = (m: number) => new Date(from.getTime() + m * MINUTE);
const now = at(120);

const facts = (over: Partial<LinkGateFacts> = {}): LinkGateFacts => ({
  linked: false, playedMs: 0, linkEndedSinceFrom: false, bannedSinceFrom: false,
  activeBan: null, lastLiftAt: null, liftsInWindow: 0, attemptOpen: false, now, ...over,
});

describe("unlinkedPlayMs", () => {
  it("counts only the overlap with [from, now]", () => {
    const sessions = [{ from: at(-30), to: at(10) }, { from: at(20), to: null }];
    expect(unlinkedPlayMs(sessions, from, at(50))).toBe(40 * MINUTE);
  });
});

describe("linkGateAction", () => {
  it("unlinked, 59m played -> none", () => {
    expect(linkGateAction(facts({ playedMs: 59 * MINUTE }))).toBe("none");
  });
  it("60m played -> ban", () => {
    expect(linkGateAction(facts({ playedMs: 60 * MINUTE }))).toBe("ban");
  });
  it("lost a link since launch -> ban at 0m played", () => {
    expect(linkGateAction(facts({ linkEndedSinceFrom: true }))).toBe("ban");
  });
  it("banned before since launch, no lift running -> ban", () => {
    expect(linkGateAction(facts({ bannedSinceFrom: true }))).toBe("ban");
  });
  it("applied ban, attempt open, no lift in window -> lift", () => {
    expect(linkGateAction(facts({ activeBan: "applied", attemptOpen: true }))).toBe("lift");
  });
  it("second attempt inside 24h -> none", () => {
    expect(linkGateAction(facts({ activeBan: "applied", attemptOpen: true, liftsInWindow: 1 }))).toBe("none");
  });
  it("applied ban, no attempt -> none", () => {
    expect(linkGateAction(facts({ activeBan: "applied" }))).toBe("none");
  });
  it("inside a lift with an attempt open -> none", () => {
    expect(linkGateAction(facts({
      bannedSinceFrom: true, attemptOpen: true, lastLiftAt: new Date(now.getTime() - 30 * MINUTE), liftsInWindow: 1,
    }))).toBe("none");
  });
  it("re-roll during lift keeps the original hour", () => {
    expect(linkGateAction(facts({
      bannedSinceFrom: true, attemptOpen: true, lastLiftAt: new Date(now.getTime() - 61 * MINUTE), liftsInWindow: 1,
    }))).toBe("ban");
  });
  it("lift running but attempt cancelled -> ban", () => {
    expect(linkGateAction(facts({
      bannedSinceFrom: true, attemptOpen: false, lastLiftAt: new Date(now.getTime() - 30 * MINUTE),
    }))).toBe("ban");
  });
  it("linked with an applied or pending ban -> close", () => {
    expect(linkGateAction(facts({ linked: true, activeBan: "applied" }))).toBe("close");
    expect(linkGateAction(facts({ linked: true, activeBan: "pending" }))).toBe("close");
  });
  it("linked with a lift_pending ban -> none", () => {
    expect(linkGateAction(facts({ linked: true, activeBan: "lift_pending" }))).toBe("none");
  });
  it("linked, no ban -> none", () => {
    expect(linkGateAction(facts({ linked: true, playedMs: 999 * MINUTE }))).toBe("none");
  });
  it("pending or lift_pending ban, unlinked -> none", () => {
    expect(linkGateAction(facts({ activeBan: "pending", playedMs: 999 * MINUTE }))).toBe("none");
    expect(linkGateAction(facts({ activeBan: "lift_pending", playedMs: 999 * MINUTE }))).toBe("none");
  });
});
