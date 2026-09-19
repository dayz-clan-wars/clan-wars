import { describe, it, expect } from "vitest";
import { safeBack } from "@/lib/form";

/**
 * ⚠️ `back` reaches this from a form field, so it is attacker-controlled. Used
 * as given it is an open redirect: a link to our own domain that bounces the
 * player to someone else's, carrying our styling and their trust.
 */
describe("safeBack", () => {
  it("allows a known site path", () => {
    expect(safeBack("/notifications", "/me")).toBe("/notifications");
    expect(safeBack("/clan", "/me")).toBe("/clan");
  });

  it("⚠️ refuses an absolute URL, whatever it looks like", () => {
    expect(safeBack("https://evil.example/x", "/me")).toBe("/me");
    expect(safeBack("//evil.example", "/me")).toBe("/me");
    expect(safeBack("http://dayzclanwars.com.evil.example", "/me")).toBe("/me");
  });

  it("⚠️ refuses a path that is not on the list", () => {
    expect(safeBack("/notifications/../admin", "/me")).toBe("/me");
    expect(safeBack("/anything-else", "/me")).toBe("/me");
    expect(safeBack("", "/me")).toBe("/me");
    expect(safeBack(null, "/me")).toBe("/me");
  });
});
