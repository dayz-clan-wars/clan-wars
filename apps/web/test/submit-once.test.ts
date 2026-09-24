import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimLanding } from "../lib/claim-landing";

/**
 * H1: every form on the signed-in tool pages posts through SubmitButton or
 * ConfirmButton, which send once. A bare `<button type="submit">` is a
 * double-tap waiting to happen. New files in these folders are covered
 * automatically.
 */
const ROOTS = ["claim", "clan", "base", "notifications"].map((d) => join(import.meta.dirname, "..", "app", "(site)", d));
const files = ROOTS.flatMap((r) => readdirSync(r, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => join(r, f)));

describe("signed-in forms send once", () => {
  it("finds the pages", () => expect(files.length).toBeGreaterThan(5));
  it.each(files)("%s has no bare submit button", (f) => {
    expect(readFileSync(f, "utf8")).not.toContain('type="submit"');
  });
});

/** ⚠️ Review focus 5. */
describe("claimLanding", () => {
  it("sends a founded clan to /clan", () => expect(claimLanding(7, "ok")).toBe("/clan"));
  it("⚠️ sends a second POST for an already-claimed ceremony to /clan, not back to the 404 its ceremony page now is", () => {
    expect(claimLanding(7, "no-such-ceremony")).toBe("/clan");
    expect(claimLanding(7, "ceremony-taken")).toBe("/clan");
  });
  it("keeps a fixable refusal on the claim page", () => {
    expect(claimLanding(7, "name-taken")).toBe("/claim/7");
    expect(claimLanding(7, "too-close")).toBe("/claim/7");
  });
});
