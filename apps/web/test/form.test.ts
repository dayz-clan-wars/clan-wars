import { describe, it, expect } from "vitest";
import { text, id, confirmed, redirectTo, optionalText } from "../lib/form";

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
  it("optionalText distinguishes absent/empty from too-long", () => {
    expect(optionalText(form({ pitch: "  hi  " }), "pitch", 32)).toBe("hi");
    expect(optionalText(form({ pitch: "   " }), "pitch", 32)).toBeNull();
    expect(optionalText(form({}), "pitch", 32)).toBeNull();
    expect(optionalText(form({ pitch: "x".repeat(33) }), "pitch", 32)).toBe("too-long");
  });
});

describe("redirectTo", () => {
  // ⚠️ This pins the fix for the `siteUrl(origin, \`${target}?x=y\`)` bug:
  // passing the query as one part of the pathname percent-encodes the "?"
  // into `%3F`, turning `/clan?result=kick.ok` into a 404 at `/clan%3Fresult=kick.ok`.
  it("redirects with a 303 to the target path, query intact", () => {
    const res = redirectTo("http://x", "/clan", "?result=kick.ok");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://x/clan?result=kick.ok");
  });

  it("preserves a path containing an encoded tag", () => {
    const res = redirectTo("http://x", "/clans/BE%20AR", "?result=request.ok");
    expect(res.headers.get("location")).toBe("http://x/clans/BE%20AR?result=request.ok");
  });

  it("builds the login hop with an encoded next", () => {
    const res = redirectTo("http://x", "/login", `?next=${encodeURIComponent("/clan")}`);
    expect(res.headers.get("location")).toBe("http://x/login?next=%2Fclan");
  });
});
