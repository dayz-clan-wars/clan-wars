import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS, CONTENT_DIR } from "../lib/guide";
import { MESSAGE_MAX, CONTENTS_CHANNEL, channelNameFor, plainChannelNameFor, canonicalChannelName, guideChannels, chapterMessages, contentsMessages, chunk, escape } from "../lib/guide-discord";

/**
 * The Discord copy of the guide is rendered from the site's own fragments;
 * this holds every chapter to Discord's message cap and to a conversion
 * that leaves no HTML, no unresolved number token and no unescaped markdown
 * behind. A new element in a fragment fails `parse` here, on purpose.
 */
const ids = new Map(CHAPTERS.map((c, i) => [c.slug, String(100000 + i)]));

describe("guide → Discord", () => {
  it.each(CHAPTERS.map((c) => [channelNameFor(c), c] as const))("%s renders under the cap with nothing left over", (_name, c) => {
    const fragment = c.file ? readFileSync(join(CONTENT_DIR, c.file), "utf8") : null;
    const msgs = chapterMessages(c, fragment, ids);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(MESSAGE_MAX);
      expect(m).not.toMatch(/<(?!#\d+>)[a-z/]/u);
      expect(m).not.toMatch(/\{\{/u);
      expect(m).not.toMatch(/&[a-z]+;/u);
    }
    expect(msgs[0]).toMatch(new RegExp(`^# ${c.number}\\. `, "u"));
    expect(msgs[msgs.length - 1]).toContain("-# Read this chapter on the site: https://dayzclanwars.com/guide");
  });

  it("names one channel per chapter plus the contents, valid for Discord and unique", () => {
    const names = guideChannels().map((c) => c.name);
    // The names CARRY their number as keycaps; what identifies a chapter is
    // the canonical form underneath.
    const plain = names.map(canonicalChannelName);
    expect(plain[0]).toBe("00-start-here");
    expect(plain).toContain("01-what-this-is");
    expect(plain).toContain("13-rules-on-one-page");
    expect(plain).toContain("a-numbers");
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(plain).size).toBe(plain.length);
    for (const n of plain) expect(n).toMatch(/^[a-z0-9-]{1,100}$/u);
    // ⚠️ Discord's own limit is on the real name, decoration included.
    for (const n of names) expect(n.length).toBeLessThanOrEqual(100);
  });

  it("turns a chapter link into that chapter's channel, or the site when the channel is unknown", () => {
    const c = CHAPTERS.find((x) => x.slug === "bases")!;
    const fragment = readFileSync(join(CONTENT_DIR, c.file!), "utf8");
    expect(chapterMessages(c, fragment, ids).join("\n")).toContain(`travel point <#${ids.get("getting-around")}>`);
    expect(chapterMessages(c, fragment, new Map()).join("\n")).toContain("travel point (https://dayzclanwars.com/guide/getting-around)");
  });

  it("renders the boxes as quotes, a wide table as bullet rows and a short one as a code block", () => {
    const bases = chapterMessages(CHAPTERS.find((x) => x.slug === "bases")!, readFileSync(join(CONTENT_DIR, "04-bases.html"), "utf8"), ids).join("\n");
    expect(bases).toContain("> **1. Every flagpole is a base.**");
    const map = chapterMessages(CHAPTERS.find((x) => x.slug === "the-map")!, readFileSync(join(CONTENT_DIR, "10-the-map.html"), "utf8"), ids).join("\n");
    expect(map).toContain("*Layer — Who sees it — What is on it*");
    expect(map).toContain("- **You** — everyone linked — your last known position");
    expect(map).toContain("> 🛰️ **What the server can see**");
    const around = chapterMessages(CHAPTERS.find((x) => x.slug === "getting-around")!, readFileSync(join(CONTENT_DIR, "11-getting-around.html"), "utf8"), ids).join("\n");
    expect(around).toMatch(/```\n#\s+Town\s+X \/ Z\n— Left arm —\n1\s+Adamow\s+3112 \/ 6516/u);
  });

  it("escapes what Discord would style, and never lets an @ become a mention", () => {
    expect(escape("a_b *c* ~d~ `e` |f| @everyone")).toBe("a\\_b \\*c\\* \\~d\\~ \\`e\\` \\|f\\| @​everyone");
  });

  it("chunks whole blocks, and splits a code block by line rather than mid-fence", () => {
    const long = `\`\`\`\n${Array.from({ length: 120 }, (_, i) => `row ${i} ${"x".repeat(30)}`).join("\n")}\n\`\`\``;
    const out = chunk(["intro", long, "outro"], 1000);
    expect(out.length).toBeGreaterThan(2);
    for (const m of out) { expect(m.length).toBeLessThanOrEqual(1000); expect((m.match(/```/gu) ?? []).length % 2).toBe(0); }
  });

  it("the contents names every chapter's channel", () => {
    const text = contentsMessages(ids).join("\n");
    for (const c of CHAPTERS) expect(text).toContain(`**${c.number}.** <#${ids.get(c.slug)}>`);
  });
});

describe("decorated channel names", () => {
  /** One keycap: the ascii character, then VS16, then the enclosing-keycap mark. */
  const keycap = (d: string) => `${d}\uFE0F\u20E3`;

  it("names a numbered chapter with keycap digits", () => {
    const ch = CHAPTERS.find((c) => c.number === "1")!;
    // ⚠️ Chapter 1's own slug is empty; `plainChannelNameFor` is what supplies
    // the `what-this-is` fallback, so the decorated name is built from that
    // rather than from `ch.slug`.
    const plain = plainChannelNameFor(ch);
    expect(plain).toBe("01-what-this-is");
    expect(channelNameFor(ch)).toBe(`${keycap("0")}${keycap("1")}${plain.slice(2)}`);
  });

  it("names the lettered appendix with a regional indicator", () => {
    const ch = CHAPTERS.find((c) => !/^\d+$/u.test(c.number));
    if (ch === undefined) return;
    expect(channelNameFor(ch)).toBe(`\u{1F1E6}-${ch.slug}`);
  });

  it("⚠️ round-trips every chapter through canonicalChannelName", () => {
    for (const c of CHAPTERS) {
      expect(canonicalChannelName(channelNameFor(c))).toBe(plainChannelNameFor(c));
    }
    expect(canonicalChannelName(CONTENTS_CHANNEL)).toBe("00-start-here");
  });

  it("⚠️ recognises the names already in Discord — this is what stops a rename creating duplicates", () => {
    // Exactly as they are in the guild today, renamed by hand.
    expect(canonicalChannelName("0️⃣0️⃣-start-here")).toBe("00-start-here");
    expect(canonicalChannelName("0️⃣1️⃣-what-this-is")).toBe("01-what-this-is");
    expect(canonicalChannelName("1️⃣4️⃣-achievements")).toBe("14-achievements");
    // ⚠️ A regional indicator carries NO ascii letter, unlike a keycap digit.
    expect(canonicalChannelName("\u{1F1E6}-numbers")).toBe("a-numbers");
  });

  it("leaves an undecorated name exactly as it is, so an untouched guild still matches", () => {
    expect(canonicalChannelName("07-the-scoreboard")).toBe("07-the-scoreboard");
    expect(canonicalChannelName("a-numbers")).toBe("a-numbers");
  });

  it("is idempotent — canonicalising twice is canonicalising once", () => {
    for (const c of CHAPTERS) {
      const once = canonicalChannelName(channelNameFor(c));
      expect(canonicalChannelName(once)).toBe(once);
    }
  });

  it("⚠️ never lets two different chapters collide on one canonical name", () => {
    const keys = CHAPTERS.map((c) => canonicalChannelName(channelNameFor(c)));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(canonicalChannelName(CONTENTS_CHANNEL));
  });
});
