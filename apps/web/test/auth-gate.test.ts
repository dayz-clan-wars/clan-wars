import { describe, it, expect } from "vitest";
import { PUBLIC_PATHS, PUBLIC_PREFIXES, AUTH_PAGES, pathIsPublic } from "../lib/auth/gate";

/**
 * ⚠️ A drift test on the gate. These three lists ARE the security boundary:
 * adding an entry makes a page reachable by anyone on the internet, and it is
 * a one-line change that reads as harmless in review. Pinning them exactly
 * means widening the gate fails a test that names what was added — a silently
 * widened gate is not something anyone reports.
 */
describe("the public allowlist is exactly this", () => {
  it("pins the public paths", () => {
    expect([...PUBLIC_PATHS]).toEqual(["/", "/clans", "/scoreboard", "/alphas", "/seasons", "/war-log", "/players", "/guide", "/mark.png", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/opengraph-image.png", "/twitter-image.png"]);
  });

  it("pins the public prefixes", () => {
    expect([...PUBLIC_PREFIXES]).toEqual(["/api/auth/", "/flags/", "/clans/", "/players/", "/guide/", "/icons/", "/hero/", "/api/players/"]);
  });

  it("pins the auth pages", () => {
    expect([...AUTH_PAGES]).toEqual(["/login", "/join"]);
  });
});

describe("pathIsPublic", () => {
  it("lets the landing page through", () => {
    expect(pathIsPublic("/")).toBe(true);
  });

  it("lets the auth endpoints and static flags through", () => {
    expect(pathIsPublic("/api/auth/discord")).toBe(true);
    expect(pathIsPublic("/api/auth/callback")).toBe(true);
    expect(pathIsPublic("/flags/Flag_Wolf.png")).toBe(true);
  });

  it("gates the prototypes", () => {
    expect(pathIsPublic("/mobile")).toBe(false);
    expect(pathIsPublic("/link")).toBe(false);
    // ⚠️ The map is login AND a linked character (spec §10.1). The middleware
    // is the login half; /map's own render is the linked half. Adding "/map"
    // to PUBLIC_PATHS would hand one clan's live positions to the internet.
    expect(pathIsPublic("/map")).toBe(false);
  });

  // ⚠️ The auth pages are NOT public — middleware handles them specially,
  // because whether they should render depends on the session they are for.
  it("does not treat the auth pages as public", () => {
    expect(pathIsPublic("/login")).toBe(false);
    expect(pathIsPublic("/join")).toBe(false);
  });

  it("is not fooled by a prefix that only looks like one", () => {
    expect(pathIsPublic("/api/authorise-me")).toBe(false);
    expect(pathIsPublic("/flagsomething")).toBe(false);
  });

  it("lets the clan directory and clan pages through, but not the member's own clan", () => {
    expect(pathIsPublic("/clans")).toBe(true);
    expect(pathIsPublic("/clans/BEAR")).toBe(true);
    expect(pathIsPublic("/clan")).toBe(false);
    expect(pathIsPublic("/clan/settings")).toBe(false);
    expect(pathIsPublic("/clansomething")).toBe(false);
  });

  it("lets the scoring pages through", () => {
    expect(pathIsPublic("/scoreboard")).toBe(true);
    expect(pathIsPublic("/alphas")).toBe(true);
    expect(pathIsPublic("/seasons")).toBe(true);
    expect(pathIsPublic("/war-log")).toBe(true);
  });

  it("lets the player boards and player profiles through, but not the clan board", () => {
    expect(pathIsPublic("/players")).toBe(true);
    expect(pathIsPublic("/players/SomeGamertag")).toBe(true);
    expect(pathIsPublic("/clan/board")).toBe(false);
    expect(pathIsPublic("/playersomething")).toBe(false);
  });

  it("lets the public gamertag autocomplete through", () => {
    expect(pathIsPublic("/api/players/suggest")).toBe(true);
    expect(pathIsPublic("/api/playersomething")).toBe(false);
  });

  it("lets the landing hero's terrain through", () => {
    expect(pathIsPublic("/hero/terrain.webp")).toBe(true);
    expect(pathIsPublic("/herosomething")).toBe(false);
  });

  it("lets the share images through for link crawlers", () => {
    expect(pathIsPublic("/opengraph-image.png")).toBe(true);
    expect(pathIsPublic("/twitter-image.png")).toBe(true);
  });

  it("lets the guide and its chapters through", () => {
    expect(pathIsPublic("/guide")).toBe(true);
    expect(pathIsPublic("/guide/05-raiding.html")).toBe(true);
    expect(pathIsPublic("/guidesomething")).toBe(false);
  });
});
