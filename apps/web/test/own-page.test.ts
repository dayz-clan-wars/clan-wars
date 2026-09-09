import { describe, it, expect } from "vitest";
import { ownPagePath, isOwnPage, homePath } from "../lib/own-page";

/**
 * A linked member's home is their public player page (/me forwards there).
 * The forward must keep the notice codes the action routes append, and the
 * "this is you" check must match the way the roster looks gamertags up.
 */
describe("ownPagePath", () => {
  it("is the player page, gamertag encoded", () => {
    expect(ownPagePath("IGC slide")).toBe("/players/IGC%20slide");
  });
  it("carries the query string through, so ?unlink= and ?result= still show", () => {
    expect(ownPagePath("RonaldRaygun552", { result: "leave.ok" })).toBe("/players/RonaldRaygun552?result=leave.ok");
    expect(ownPagePath("RonaldRaygun552", { unlink: "refused", result: undefined })).toBe("/players/RonaldRaygun552?unlink=refused");
    expect(ownPagePath("RonaldRaygun552", {})).toBe("/players/RonaldRaygun552");
  });
});

describe("isOwnPage", () => {
  it("matches the roster's lookup: case-insensitive", () => {
    expect(isOwnPage("ronaldraygun552", "RonaldRaygun552")).toBe(true);
  });
  it("no link, or another player, is not you", () => {
    expect(isOwnPage(null, "RonaldRaygun552")).toBe(false);
    expect(isOwnPage(undefined, "RonaldRaygun552")).toBe(false);
    expect(isOwnPage("Someone", "RonaldRaygun552")).toBe(false);
  });
});

describe("homePath: where /me forwards", () => {
  it("a linked member's home is their player page", () => {
    expect(homePath("RonaldRaygun552", { result: "leave.ok" })).toBe("/players/RonaldRaygun552?result=leave.ok");
  });
  it("before a character is linked, home is the link flow, notice codes kept", () => {
    expect(homePath(null, {})).toBe("/link");
    expect(homePath(undefined, { unlink: "ok" })).toBe("/link?unlink=ok");
  });
});
