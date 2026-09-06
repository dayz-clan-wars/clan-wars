import { describe, it, expect } from "vitest";
import { text, id, confirmed } from "../lib/form";

const form = (entries: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(entries)) f.set(k, v); return f; };

describe("form field readers", () => {
  it("text trims, and refuses empty or over-long values", () => {
    expect(text(form({ name: "  Bears " }), "name", 32)).toBe("Bears");
    expect(text(form({ name: "   " }), "name", 32)).toBeNull();
    expect(text(form({ name: "x".repeat(33) }), "name", 32)).toBeNull();
    expect(text(form({}), "name", 32)).toBeNull();
  });
  it("id accepts decimal digits only", () => {
    expect(id(form({ inviteId: "42" }), "inviteId")).toBe(42);
    expect(id(form({ inviteId: "4e2" }), "inviteId")).toBeNull();
    expect(id(form({ inviteId: "-1" }), "inviteId")).toBeNull();
    expect(id(form({ inviteId: "1".repeat(13) }), "inviteId")).toBeNull();
  });
  it("confirmed is the literal yes", () => {
    expect(confirmed(form({ confirm: "yes" }))).toBe(true);
    expect(confirmed(form({ confirm: "on" }))).toBe(false);
  });
});
