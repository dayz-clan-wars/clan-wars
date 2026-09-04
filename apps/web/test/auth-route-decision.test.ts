import { describe, it, expect } from "vitest";
import { decideRoute } from "../lib/auth/route-decision";
import type { Session } from "../lib/auth/session";

const member: Session = {
  sub: "1",
  name: "Player",
  avatar: null,
  guild: true,
  nextCheckAt: 2_000,
  authAt: 1_000,
};

const kicked: Session = { ...member, guild: false };

describe("decideRoute", () => {
  it("gates a page with no session at all: redirect to /login remembering here", () => {
    const d = decideRoute({ pathname: "/mobile", existing: null, session: null, wanted: "/", here: "/mobile" });
    expect(d).toEqual({ action: "redirect", target: "/login", next: "/mobile" });
  });

  it("allows a gated page for a current member", () => {
    const d = decideRoute({
      pathname: "/mobile",
      existing: member,
      session: member,
      wanted: "/",
      here: "/mobile",
    });
    expect(d).toEqual({ action: "allow" });
  });

  // ⚠️ This is the kicked-member bug: `existing` still says guild:true (the
  // stale cookie), but the just-refreshed `session` says guild:false. The
  // decision must follow `session`, not `existing`, or a kicked member never
  // leaves the gated page.
  it("sends a just-kicked member to /join, following the REFRESHED session", () => {
    const d = decideRoute({
      pathname: "/mobile",
      existing: member,
      session: kicked,
      wanted: "/",
      here: "/mobile",
    });
    expect(d).toEqual({ action: "redirect", target: "/join", next: "/mobile" });
  });

  it("/login sends a signed-in member on to `wanted`", () => {
    const d = decideRoute({ pathname: "/login", existing: member, session: member, wanted: "/mobile", here: "/login" });
    expect(d).toEqual({ action: "redirect", target: "/mobile" });
  });

  it("/login renders for anyone without guild access", () => {
    expect(
      decideRoute({ pathname: "/login", existing: null, session: null, wanted: "/", here: "/login" }),
    ).toEqual({ action: "allow" });
    expect(
      decideRoute({ pathname: "/login", existing: kicked, session: kicked, wanted: "/", here: "/login" }),
    ).toEqual({ action: "allow" });
  });

  it("/join sends someone with no session to /login, remembering /join", () => {
    const d = decideRoute({ pathname: "/join", existing: null, session: null, wanted: "/", here: "/join" });
    expect(d).toEqual({ action: "redirect", target: "/login", next: "/join" });
  });

  it("/join sends a current member on to `wanted`", () => {
    const d = decideRoute({ pathname: "/join", existing: member, session: member, wanted: "/mobile", here: "/join" });
    expect(d).toEqual({ action: "redirect", target: "/mobile" });
  });

  it("/join renders for a non-member", () => {
    const d = decideRoute({ pathname: "/join", existing: kicked, session: kicked, wanted: "/", here: "/join" });
    expect(d).toEqual({ action: "allow" });
  });
});
