import { describe, it, expect } from "vitest";
import { text, id, confirmed, redirectTo, optionalText, resultQuery, keepFrom, readKept, KEEP_VALUE_MAX, KEEP_LIST_MAX } from "../lib/form";

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

describe("resultQuery: a refusal carries back what was typed (H2)", () => {
  it("is only the result when nothing is kept", () => {
    expect(resultQuery("kick.ok")).toBe("?result=kick.ok");
  });

  /** ⚠️ Review focus 2. */
  it("⚠️ round-trips &, =, + and unicode without breaking the query", () => {
    const typed = "Bread & Roses = +1 ✦ Ñandú";
    const back = new URLSearchParams(resultQuery("rename.name-taken", { name: typed }).slice(1));
    expect(back.get("result")).toBe("rename.name-taken");
    expect(back.get("kept.name")).toBe(typed);
    expect([...back.keys()]).toEqual(["result", "kept.name"]);
  });

  /** ⚠️ Review focus 3. */
  it("⚠️ never carries a vault code, whatever the caller passes", () => {
    const q = resultQuery("add.bad-name", { name: "Gate", code: "1234" });
    expect(q).not.toContain("1234");
    expect(q).not.toContain("kept.code");
  });

  it("⚠️ drops an over-long value rather than cutting it", () => {
    const back = new URLSearchParams(resultQuery("claim.bad-name", { name: "x".repeat(KEEP_VALUE_MAX + 1), tag: "IRON" }).slice(1));
    expect(back.get("kept.name")).toBeNull();
    expect(back.get("kept.tag")).toBe("IRON");
  });

  it("repeats a list, up to the cap", () => {
    const q = resultQuery("claim.bad-roster", { member: Array.from({ length: KEEP_LIST_MAX }, (_, i) => `p${i}`) });
    expect(new URLSearchParams(q.slice(1)).getAll("kept.member")).toHaveLength(KEEP_LIST_MAX);
  });

  /**
   * F2: a list over the cap is DROPPED ENTIRELY, matching the file's own
   * "an over-long value is dropped, not cut" rule — truncating the claim
   * roster silently keeps the first sixteen names ticked and drops the rest
   * with no sign anything is missing. Dropping it makes the claim form fall
   * back to its default (all ticked), which is at least honest about what
   * the player gets.
   */
  it("⚠️ drops an over-long list entirely, rather than cutting it to the cap", () => {
    const q = resultQuery("claim.bad-roster", { member: Array.from({ length: KEEP_LIST_MAX + 4 }, (_, i) => `p${i}`) });
    expect(new URLSearchParams(q.slice(1)).getAll("kept.member")).toEqual([]);
    expect(q).toBe("?result=claim.bad-roster");
  });

  /** ⚠️ Review round 1: NEVER_KEEP must catch every spelling, not just the exact string "code". */
  it("⚠️ never carries a vault code under a differently-cased name", () => {
    const q = resultQuery("add.bad-name", { Code: "SECRET5678" });
    expect(q).not.toContain("SECRET5678");
    expect(q).toBe("?result=add.bad-name");
  });

  it("⚠️ never carries a vault code under a dotted name forging a kept.code segment", () => {
    const q = resultQuery("add.bad-name", { "kept.code": "SECRET1234" });
    expect(q).not.toContain("SECRET1234");
    expect(q).toBe("?result=add.bad-name");
  });

  it("still keeps a normal field alongside the rejected ones", () => {
    const back = new URLSearchParams(resultQuery("add.bad-name", { Code: "SECRET5678", name: "Gate" }).slice(1));
    expect(back.get("kept.name")).toBe("Gate");
    expect([...back.keys()]).toEqual(["result", "kept.name"]);
  });
});

describe("keepFrom", () => {
  it("keeps only the named fields, trimmed, within their own limits", () => {
    const f = form({ name: "  Iron  ", tag: "TOOLONG", code: "1234", note: "" });
    expect(keepFrom(f, { name: 32, tag: 5, note: 140 })).toEqual({ name: "Iron" });
  });

  it("⚠️ refuses code even when a caller lists it", () => {
    expect(keepFrom(form({ code: "1234" }), { code: 4 })).toEqual({});
  });

  /** ⚠️ Review round 1: same normalization on the keepFrom side. */
  it("⚠️ refuses code under any case or dotted spelling of the field name", () => {
    const f = form({ Code: "1234", CODE: "5678", "kept.code": "9012", name: "Iron" });
    expect(keepFrom(f, { Code: 4, CODE: 4, "kept.code": 4, name: 32 })).toEqual({ name: "Iron" });
  });
});

describe("readKept", () => {
  it("reads single and repeated values", () => {
    const k = readKept({ "kept.name": "Iron", "kept.member": ["a", "b"], result: "claim.bad-name" });
    expect(k.get("name")).toBe("Iron");
    expect(k.all("member")).toEqual(["a", "b"]);
    expect(k.get("tag")).toBeUndefined();
  });

  /** ⚠️ Review focus 3: a crafted link cannot put a code into the page. */
  it("⚠️ refuses `code` even from a crafted URL", () => {
    expect(readKept({ "kept.code": "1234" }).get("code")).toBeUndefined();
  });

  it("refuses over-long values and prototype keys", () => {
    expect(readKept({ "kept.name": "x".repeat(KEEP_VALUE_MAX + 1) }).get("name")).toBeUndefined();
    expect(readKept({}).get("constructor")).toBeUndefined();
  });

  /** F2, same rule read-side: a forged link naming an over-cap list must not truncate to the first N. */
  it("⚠️ drops an over-long list entirely, rather than cutting it to the cap", () => {
    const list = Array.from({ length: KEEP_LIST_MAX + 4 }, (_, i) => `p${i}`);
    expect(readKept({ "kept.member": list }).all("member")).toEqual([]);
  });
});
