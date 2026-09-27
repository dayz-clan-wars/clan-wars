import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@/lib/auth/session";
import type { Owner } from "../app/components/owner";
import { AccountPanel } from "../app/components/owner";
import { broughtLine, referralFactRows } from "../lib/referral-view";
import { code, RESULT_COPY } from "../lib/clan-copy";

const app = join(import.meta.dirname, "..", "app");
const read = (...p: string[]) => readFileSync(join(app, ...p), "utf8");

const SESSION: Session = { sub: "1", name: "Test", avatar: null, guild: true, nextCheckAt: 0, authAt: 0 };

const baseOwner = (): Owner => ({
  session: SESSION,
  viewer: { link: { dayzId: "dz", gamertag: "Ada", verifiedAt: new Date() }, clan: null, pending: null },
  invites: [],
  requests: [],
  claim: null,
  next: null,
  showInvites: false,
  boosting: false,
  openAwards: 0,
  referrals: { referredBy: null, brought: [] },
});

describe("AccountPanel's referral block", () => {
  it("shows 'Referred by' with a link, once a referrer is set", () => {
    const owner: Owner = { ...baseOwner(), referrals: { referredBy: { gamertag: "Boris" }, brought: [] } };
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner }));
    expect(html).toContain("Referred by");
    expect(html).toContain('href="/players/Boris"');
    expect(html).toContain("Boris");
    // Never a form once a referrer is on record — the record is permanent.
    expect(html).not.toContain('action="/api/referral"');
  });

  it("names nobody and links nowhere when the referrer's name is no longer known", () => {
    const owner: Owner = { ...baseOwner(), referrals: { referredBy: { gamertag: null }, brought: [] } };
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner }));
    expect(html).toContain("Referred by a player no longer linked.");
    expect(html).not.toContain("/players/");
    expect(html).not.toContain('action="/api/referral"');
  });

  it("shows the form with the permanence warning when no referrer is set", () => {
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner: baseOwner() }));
    expect(html).toContain('action="/api/referral"');
    expect(html).toContain("Save referrer");
    expect(html).toContain("This can");
    expect(html).toContain("t be changed later");
    expect(html).not.toContain("Referred by");
  });

  it("keeps a refused referrer's typed name in the field", () => {
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner: baseOwner(), keptReferrer: "Pavel" }));
    expect(html).toContain("Pavel");
  });
});

describe("broughtLine", () => {
  it("lists linked names", () => {
    expect(broughtLine([{ gamertag: "A" }, { gamertag: "B" }])).toBe("Brought in 2 players: A, B");
  });
  it("counts an unlinked one without naming it", () => {
    const line = broughtLine([{ gamertag: "A" }, { gamertag: null }]);
    expect(line).toContain("Brought in 2 players");
    expect(line).toContain("A");
    expect(line).toContain("1 player no longer linked");
  });
  it("handles a single brought-in player", () => {
    expect(broughtLine([{ gamertag: "A" }])).toBe("Brought in 1 player: A");
  });
});

describe("referralFactRows", () => {
  it("is empty for a null view (unlinked profile, or a failed read)", () => {
    expect(referralFactRows(null)).toEqual([]);
  });
  it("is empty when there is nothing to show", () => {
    expect(referralFactRows({ referredBy: null, brought: [] })).toEqual([]);
  });
  it("adds a 'Referred by' row", () => {
    const rows = referralFactRows({ referredBy: { gamertag: "Boris" }, brought: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe("Referred by");
  });
  it("says 'a player no longer linked', unlinked, when the referrer's name is not known", () => {
    const rows = referralFactRows({ referredBy: { gamertag: null }, brought: [] });
    expect(rows).toEqual([["Referred by", "a player no longer linked"]]);
  });
  it("adds a 'Brought in' row only when someone was brought in", () => {
    const rows = referralFactRows({ referredBy: null, brought: [{ gamertag: "A" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe("Brought in");
  });
});

describe("the site's referral result codes", () => {
  it("are looked up in RESULT_COPY, the same table every other route uses", () => {
    expect(RESULT_COPY[code("referral", "recorded")]).toBeTruthy();
    expect(RESULT_COPY[code("referral", "self")]).toBeTruthy();
    expect(RESULT_COPY[code("referral", "already-referred")]).toBeTruthy();
    expect(RESULT_COPY[code("referral", "not-linked")]).toBeTruthy();
  });
});

describe("the /api/link/start route", () => {
  const src = read("api", "link", "start", "route.ts");
  it("passes a typed referrer through to startLink as referrerGamertag", () => {
    expect(src).toContain("referrerGamertag");
    expect(src).toContain("startLink(");
  });
  it("tells startLink the site is the surface, so a link-time referral records link_site", () => {
    expect(src).toContain(`surface: "site"`);
  });
  it("rejects a referrer over the gamertag length with bad-referrer, before calling startLink", () => {
    expect(src).toContain("GAMERTAG_MAX");
    const rejectIdx = src.indexOf("bad-referrer");
    const callIdx = src.indexOf("startLink(");
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeLessThan(callIdx);
  });
});

describe("the /api/referral route", () => {
  const src = read("api", "referral", "route.ts");
  it("is a POST", () => {
    expect(src).toMatch(/export async function POST\(/u);
    expect(src).not.toMatch(/export async function GET\(/u);
  });
  it("requires a session, through formAction's own gate", () => {
    expect(src).toContain("formAction(");
  });
  it("records via addReferrer and redirects with a looked-up code", () => {
    expect(src).toContain("addReferrer(");
    expect(src).toContain('code("referral", "recorded")');
  });
  it("keeps the typed referrer on a refusal", () => {
    expect(src).toMatch(/keep:\s*\{\s*referrer\s*\}/u);
  });
  it("redirects to the caller's own profile, read fresh from viewerFor rather than trusted from the form", () => {
    expect(src).toContain("viewerFor(");
    expect(src).toMatch(/\/players\/\$\{encodeURIComponent\(viewer\.link\.gamertag\)\}/u);
  });
});

describe("the public profile shows referrals", () => {
  const src = read("(site)", "players", "[gamertag]", "page.tsx");
  it("reads referralsForDayzId by the profile's own dayzId, wrapped in .catch(() => null) like achievementsFor", () => {
    expect(src).toContain("referralsForDayzId(profile.dayzId)");
    expect(src).not.toContain("referralsForGamertag");
    expect(src).toMatch(/referralsForDayzId\([^)]*\)\.catch\(/u);
  });
  it("renders the referral rows in the Activity panel", () => {
    expect(src).toContain("referralFactRows(referrals)");
  });
});
