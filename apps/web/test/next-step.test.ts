import { describe, it, expect } from "vitest";
import { nextStepFor, type NextStepInput } from "../lib/next-step";

const base: NextStepInput = { linked: true, challengeOpen: false, inClan: false, pending: null, ceremonyId: null, invites: [], requests: [] };

describe("nextStepFor picks one state in order", () => {
  it("a ceremony beats everything", () => {
    expect(nextStepFor({ ...base, ceremonyId: 7, linked: false })?.primary.href).toBe("/claim/7");
  });
  it("an open challenge, then not linked", () => {
    expect(nextStepFor({ ...base, linked: false, challengeOpen: true })?.title).toBe("Prove it's you");
    expect(nextStepFor({ ...base, linked: false })?.title).toBe("Link your character");
  });
  it("pending sends you to the base; a full member gets nothing", () => {
    expect(nextStepFor({ ...base, pending: { name: "Bear Company" } })?.body).toContain("Bear Company");
    expect(nextStepFor({ ...base, inClan: true })).toBeNull();
  });
  it("invites name the first clan and count the rest", () => {
    const s = nextStepFor({ ...base, invites: [{ id: 1, clanName: "Bear Company" }, { id: 2, clanName: "Wolves" }] });
    expect(s?.body).toContain("Bear Company has invited you (and 1 more)");
    expect(s?.primary.href).toBe("#invites");
  });
  it("a request open, then plain no-clan", () => {
    expect(nextStepFor({ ...base, requests: [{ clanName: "Wolves" }] })?.title).toBe("Waiting on a clan");
    expect(nextStepFor(base)?.primary.href).toBe("/clans");
  });
});
