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
    expect([...PUBLIC_PATHS]).toEqual(["/"]);
  });

  it("pins the public prefixes", () => {
    expect([...PUBLIC_PREFIXES]).toEqual(["/api/auth/", "/flags/"]);
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
});
