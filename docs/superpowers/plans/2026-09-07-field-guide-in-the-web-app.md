# Field Guide in the Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the field guide from dayzclanwars.com/guide out of `apps/web`, replacing the redirect to the GitHub Pages host.

**Architecture:** Each chapter's body is a hand-written HTML fragment under `apps/web/content/guide/`; a manifest in `lib/guide.ts` is the single source of chapter order, slugs, titles and ledes; `app/guide/` renders the shell (rail, top bar, pager) around the fragment as statically generated pages. The guide's stylesheet is ported onto the app's `@theme` tokens and scoped under one wrapper class.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4 (`@theme` tokens in `app/globals.css`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-field-guide-in-the-web-app-design.md`

## Global Constraints

- The palette is stated exactly once, in `app/globals.css`'s `@theme` block (`test/theme-tokens.test.ts`). `guide.css` declares no `--color-*` or `--font-*` token.
- `/guide` and `/guide/` are already in `lib/auth/gate.ts`'s public lists; do not change the lists, only their comments (`test/auth-gate.test.ts` pins them).
- Guide numbers live in `packages/domain/src/rules.ts` and the guide; the rows of `docs/guide-numbers.json` must be unchanged after regeneration.
- Every command runs from `/Users/steveharmeyer/Development/dayz-clan-wars/clan-wars` on branch `feat/guide-in-web`. The source repo is `../field-guide/`.
- Commit messages end with the session's `Co-Authored-By` and `Claude-Session` trailers.

---

### Task 1: Content fragments and the manifest

**Files:**
- Create: `apps/web/content/guide/{01-what-this-is,02-getting-in,…,13-rules-on-one-page,numbers}.html` (14 files)
- Create: `apps/web/public/guide/logo.png`
- Replace: `apps/web/lib/guide.ts`
- Create: `apps/web/test/guide.test.ts`

**Interfaces:**
- Produces: `CHAPTERS: readonly Chapter[]`, `Chapter = { slug: string; number: string; title: string; lede: string; file: string }`, `GUIDE_DESCRIPTION: string`, `hrefFor(c: Chapter): string`, `chapterBySlug(slug: string): Chapter | undefined`, `neighbours(c: Chapter): { prev?: Chapter; next?: Chapter }`, `CONTENT_DIR: string`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/guide.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS, CONTENT_DIR, chapterBySlug, hrefFor, neighbours } from "../lib/guide";

/**
 * The guide is the authority over every rule (CLAUDE.md, "Where things
 * live"), and since 2026-09-07 it is served from this app, not redirected to
 * its old host. The manifest is the one statement of chapter order; the
 * fragments are hand-written HTML. ⚠️ A fragment that still links to a
 * `.html` page is a link to the old, dead host.
 */
describe("the guide manifest", () => {
  it("has 14 chapters, unique slugs, chapter 1 at /guide, the numbers appendix last", () => {
    expect(CHAPTERS).toHaveLength(14);
    expect(new Set(CHAPTERS.map((c) => c.slug)).size).toBe(14);
    expect(CHAPTERS[0]!.slug).toBe("");
    expect(hrefFor(CHAPTERS[0]!)).toBe("/guide");
    expect(CHAPTERS[13]!.slug).toBe("numbers");
    expect(hrefFor(CHAPTERS[13]!)).toBe("/guide/numbers");
    expect(CHAPTERS.slice(0, 13).map((c) => c.number)).toEqual(Array.from({ length: 13 }, (_, i) => String(i + 1)));
    expect(CHAPTERS[13]!.number).toBe("A");
  });

  it("looks chapters up by slug and walks neighbours", () => {
    expect(chapterBySlug("")).toBe(CHAPTERS[0]);
    expect(chapterBySlug("bases")?.title).toBe("Bases");
    expect(chapterBySlug("nope")).toBeUndefined();
    expect(neighbours(CHAPTERS[0]!)).toEqual({ prev: undefined, next: CHAPTERS[1] });
    expect(neighbours(CHAPTERS[13]!)).toEqual({ prev: CHAPTERS[12], next: undefined });
  });
});

describe("the fragments", () => {
  it.each(CHAPTERS.map((c) => [c.file, c] as const))("%s exists and links only inside the site", (file) => {
    const path = join(CONTENT_DIR, file);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).not.toMatch(/href="[^"]*\.html/u);
    expect(html).not.toMatch(/<script/iu);
    // The shell renders these; a fragment carrying its own is a double.
    expect(html).not.toMatch(/class="(opener|pager|topbar|rail)"/u);
  });

  it("keeps the numbers table in the shape scripts/guide-numbers.ts parses", () => {
    const html = readFileSync(join(CONTENT_DIR, "numbers.html"), "utf8");
    const rows = html.match(/<tr><td>[^<]*<\/td><td class="v">[^<]*<\/td><\/tr>/gu) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts`
Expected: FAIL — `CHAPTERS` is not exported from `../lib/guide`.

- [ ] **Step 3: Extract the fragments and copy the logo**

Run this once from the repo root. It takes everything between the opener's closing `</header>` and the pager, rewrites the `.html` links to the new paths, and strips trailing whitespace.

```bash
mkdir -p apps/web/content/guide apps/web/public/guide
cp ../field-guide/assets/logo.png apps/web/public/guide/logo.png
python3 - <<'PY'
import re, pathlib
src = pathlib.Path("../field-guide"); out = pathlib.Path("apps/web/content/guide")
names = {"index.html": "01-what-this-is.html", "numbers.html": "numbers.html"}
for p in sorted(src.glob("*.html")):
    names.setdefault(p.name, p.name)
slug = lambda name: "" if name == "index.html" else name.removesuffix(".html").split("-", 1)[1] if name[0].isdigit() else name.removesuffix(".html")
href = {n: ("/guide" if not slug(n) else f"/guide/{slug(n)}") for n in names}
for name, target in names.items():
    s = (src / name).read_text()
    body = s.split("</header>", 2)[2].split('<nav class="pager"')[0]
    body = re.sub(r'href="([^"]+\.html)"', lambda m: f'href="{href[m.group(1)]}"', body)
    (out / target).write_text(body.strip() + "\n")
    print(target)
PY
```

- [ ] **Step 4: Write the manifest**

```ts
// apps/web/lib/guide.ts
import { join } from "node:path";

/**
 * The field guide's table of contents — the one statement of chapter order,
 * slugs and titles. The chapters themselves are hand-written HTML fragments in
 * `content/guide/` (the inside of each old page's <article>, minus the chrome
 * the shell in app/guide renders). The guide is the authority over every rule
 * (CLAUDE.md, "Where things live"); until 2026-09-07 it lived in its own repo
 * and `/guide` was a redirect to fieldguide.dayzclanwars.com.
 *
 * ⚠️ `number` is a string because the appendix is "A". Chapter 1's slug is ""
 * so `/guide` and `hrefFor` compose without a special case.
 */
export type Chapter = { slug: string; number: string; title: string; lede: string; file: string };

export const GUIDE_DESCRIPTION =
  "The player's guide to DayZ Clan Wars: how clans are founded, how bases work, how raids score, and what the server can see.";

/** Where the fragments live. Read at build time only: every guide page is statically generated. */
export const CONTENT_DIR = join(process.cwd(), "content", "guide");

export const CHAPTERS: readonly Chapter[] = [
  { slug: "", number: "1", title: "What this is", file: "01-what-this-is.html",
    lede: "Clan Wars is a reputation war. Found a clan at a flagpole, fly one of thirty-three flags, and raid other clans to climb the scoreboard." },
  { slug: "getting-in", number: "2", title: "Getting in", file: "02-getting-in.html",
    lede: "Join the Discord, log in with it, prove you own your gamertag with three emotes. Then everything opens up." },
  { slug: "founding-a-clan", number: "3", title: "Founding a clan", file: "03-founding-a-clan.html",
    lede: "Three linked players, one white flag, ten minutes. Then a name, a tag, and one of the 33 clan flags." },
  { slug: "bases", number: "4", title: "Bases", file: "04-bases.html",
    lede: "Every flagpole is a base. Declare yours and it is private. Every other base on the server is on the map." },
  { slug: "raiding", number: "5", title: "Raiding", file: "05-raiding.html",
    lede: "A raid is simple: someone who is not in the clan lowers the clan's flag at its declared base." },
  { slug: "defending", number: "6", title: "Defending", file: "06-defending.html",
    lede: "Flag down, 24 hours. Raise it and it is a defense. Miss it and you go dormant. Getting raided can never cost you your colors." },
  { slug: "the-scoreboard", number: "7", title: "The scoreboard", file: "07-the-scoreboard.html",
    lede: "Only raids score. The higher the victim, the more it is worth. Weekly Alphas, a season champion, and a stat line for every player." },
  { slug: "running-a-clan", number: "8", title: "Running a clan", file: "08-running-a-clan.html",
    lede: "Ranks, the cap, joining and leaving, who leads and how that changes, moving house, and the vault." },
  { slug: "discord", number: "9", title: "Discord", file: "09-discord.html",
    lede: "The bot runs its own server. It announces, it keeps your clan's channel, and it DMs you when something needs you. You manage your clan on the site, not in Discord." },
  { slug: "the-map", number: "10", title: "The map", file: "10-the-map.html",
    lede: "Livonia, full screen, built for a phone. What you see depends on who you are, and every layer is a switch." },
  { slug: "getting-around", number: "11", title: "Getting around", file: "11-getting-around.html",
    lede: "Livonia is big. You no longer have to walk it. Stand at a travel point, relog, pick a door." },
  { slug: "fair-play", number: "12", title: "Fair play", file: "12-fair-play.html",
    lede: "Everything else in this guide is enforced by the server log. This chapter is enforced by people." },
  { slug: "rules-on-one-page", number: "13", title: "The rules on one page", file: "13-rules-on-one-page.html",
    lede: "Every promise in this guide, one line each. If it is not here, it is not a rule." },
  { slug: "numbers", number: "A", title: "Every number", file: "numbers.html",
    lede: "Every timer, cap, radius and cooldown, in one table." },
];

export function hrefFor(c: Chapter): string {
  return c.slug ? `/guide/${c.slug}` : "/guide";
}

export function chapterBySlug(slug: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function neighbours(c: Chapter): { prev?: Chapter; next?: Chapter } {
  const i = CHAPTERS.indexOf(c);
  return { prev: CHAPTERS[i - 1], next: CHAPTERS[i + 1] };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts`
Expected: PASS (17 tests). If a fragment fails the `class="opener"` check, the split in Step 3 missed a header; inspect that file.

- [ ] **Step 6: Commit**

```bash
git add apps/web/content apps/web/public/guide apps/web/lib/guide.ts apps/web/test/guide.test.ts
git commit -m "feat(guide): chapter fragments and manifest under apps/web"
```

---

### Task 2: The shell, the stylesheet, and the pages

**Files:**
- Create: `apps/web/app/guide/guide.css`
- Create: `apps/web/app/guide/contents.tsx` (client)
- Create: `apps/web/app/guide/layout.tsx`
- Create: `apps/web/app/guide/chapter.tsx`
- Create: `apps/web/app/guide/page.tsx`
- Create: `apps/web/app/guide/[slug]/page.tsx`
- Modify: `apps/web/test/guide.test.ts` (add the stylesheet test)

**Interfaces:**
- Consumes: everything Task 1 exports from `lib/guide`.
- Produces: `ChapterPage({ chapter }: { chapter: Chapter })` server component; `chapterMetadata(chapter): Metadata`.

- [ ] **Step 1: Add the failing stylesheet test**

Append to `apps/web/test/guide.test.ts`:

```ts
describe("guide.css rides on @theme", () => {
  const dir = join(import.meta.dirname, "..", "app");
  const css = readFileSync(join(dir, "guide", "guide.css"), "utf8");
  const theme = readFileSync(join(dir, "globals.css"), "utf8").match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
  const declared = (s: string) => new Set([...s.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmu)].map((m) => m[1]!));

  it("⚠️ declares no colour or face of its own — the palette is stated once, in globals.css", () => {
    for (const name of declared(css)) expect(name).not.toMatch(/^--(color|font)-/u);
  });

  it("references only tokens @theme or it declares", () => {
    const known = new Set([...declared(theme), ...declared(css)]);
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/gu)) expect(known.has(m[1]!), m[1]).toBe(true);
  });

  it("scopes every element selector under .guide", () => {
    // Tailwind's preflight and the rest of the site must not pick these up.
    const bare = [...css.matchAll(/^(h1|h2|h3|p|ul|ol|li|a|table|th|td|strong|em|hr|code|kbd|main|body|html)\b[^{]*\{/gmu)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts`
Expected: FAIL — ENOENT on `guide.css`.

- [ ] **Step 3: Write the stylesheet**

`apps/web/app/guide/guide.css` — the old `assets/style.css` with the palette block removed, tokens renamed, and everything scoped under `.guide`. ⚠️ Tailwind v4's preflight zeroes list styles and margins, so `ul`/`ol` get their markers back explicitly.

```css
/* apps/web/app/guide/guide.css
   The field guide's stylesheet, ported from the old field-guide repo's
   assets/style.css. Colours and faces are the app's @theme tokens
   (globals.css) — nothing is restated here (test/guide.test.ts). Every rule
   is scoped under .guide so the site's other pages never see them. */

.guide {
  --measure: 66ch;
  --rail: 280px;
  font-size: 17px;
  line-height: 1.6;
  color: var(--color-ink);
}
@media (min-width: 1000px) { .guide { font-size: 18px; } }

.guide a { color: var(--color-gold); text-decoration: none; }
.guide a:hover, .guide a:focus-visible { text-decoration: underline; text-underline-offset: 3px; }
.guide :focus-visible { outline: 2px solid var(--color-gold); outline-offset: 3px; }

/* ---------- shell ---------- */

.guide .shell { display: flex; min-height: 100vh; }

.guide .rail {
  display: none;
  width: var(--rail);
  flex: 0 0 var(--rail);
  border-right: 1px solid var(--color-rule);
  background: var(--color-frame);
}
.guide .rail-inner { position: sticky; top: 0; padding: 28px 22px 40px; max-height: 100vh; overflow-y: auto; }
.guide .rail img { width: 120px; height: 120px; display: block; margin-bottom: 18px; }
.guide .rail .kicker { color: var(--color-muted); font-size: 13px; margin: 0 0 22px; }

.guide .toc { list-style: none; margin: 0; padding: 0; }
.guide .toc li { margin: 0; }
.guide .toc a {
  display: grid; grid-template-columns: 2ch 1fr; gap: 12px;
  padding: 7px 0; color: var(--color-ink-2); font-size: 14.5px; line-height: 1.35;
}
.guide .toc a .n { color: var(--color-dim); font-family: var(--font-mono); font-size: 12.5px; padding-top: 2px; }
.guide .toc a:hover { color: var(--color-ink); text-decoration: none; }
.guide .toc a[aria-current="page"] { color: var(--color-gold); }
.guide .toc a[aria-current="page"] .n { color: var(--color-gold); }
.guide .toc .sep { border-top: 1px solid var(--color-rule-2); margin: 12px 0; }

.guide .topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 18px; border-bottom: 1px solid var(--color-rule); background: var(--color-frame);
  position: sticky; top: 0; z-index: 5;
}
.guide .topbar img { width: 40px; height: 40px; }
.guide .topbar .brand { display: flex; align-items: center; gap: 12px; color: var(--color-ink); font-family: var(--font-display); font-size: 15px; letter-spacing: .02em; }
.guide .topbar details { position: relative; }
.guide .topbar summary {
  list-style: none; cursor: pointer; color: var(--color-gold); font-size: 15px;
  padding: 10px 4px; min-height: 44px; display: flex; align-items: center;
}
.guide .topbar summary::-webkit-details-marker { display: none; }
.guide .topbar details[open] summary { color: var(--color-ink); }
.guide .topbar .menu {
  position: absolute; right: 0; top: 100%; width: min(86vw, 340px);
  background: var(--color-surface); border: 1px solid var(--color-rule-2); padding: 12px 16px;
  max-height: 75vh; overflow-y: auto;
}
.guide .topbar .menu .toc a { padding: 9px 0; min-height: 44px; align-items: center; }

@media (min-width: 1000px) {
  .guide .rail { display: block; }
  .guide .topbar { display: none; }
}

.guide main { flex: 1 1 auto; min-width: 0; }
.guide .page { padding: 28px 20px 64px; max-width: calc(var(--measure) + 40px); }
@media (min-width: 700px) { .guide .page { padding: 48px 40px 96px; } }
@media (min-width: 1000px) { .guide .page { padding: 64px 64px 120px; } }

/* ---------- chapter opener ---------- */

.guide .opener { margin: 0 0 40px; padding-bottom: 28px; border-bottom: 1px solid var(--color-rule-2); }
.guide .opener .num {
  display: block; font-family: var(--font-display); color: var(--color-gold);
  font-size: 88px; line-height: .9; letter-spacing: -.02em; margin: 0 0 8px -3px;
}
@media (min-width: 700px) { .guide .opener .num { font-size: 128px; } }
.guide .opener h1 {
  font-family: var(--font-display); font-weight: 400; margin: 0;
  font-size: 34px; line-height: 1.08; letter-spacing: -.01em;
}
@media (min-width: 700px) { .guide .opener h1 { font-size: 46px; } }
.guide .opener .lede { color: var(--color-ink-2); font-size: 1.1em; margin: 16px 0 0; max-width: 56ch; }

/* ---------- text ---------- */

.guide h2 {
  font-family: var(--font-display); font-weight: 400; font-size: 1.45em; line-height: 1.2;
  margin: 2.2em 0 .6em; letter-spacing: -.005em;
}
.guide h3 { font-size: 1.05em; font-weight: 700; margin: 1.8em 0 .4em; }
.guide p { margin: 0 0 1em; max-width: var(--measure); }
.guide ul, .guide ol { padding-left: 1.3em; margin: 0 0 1.1em; max-width: var(--measure); }
.guide ul { list-style: disc; }
.guide ol { list-style: decimal; }
.guide li { margin: 0 0 .45em; }
.guide li::marker { color: var(--color-muted); }
.guide strong { color: #fff; font-weight: 700; }
.guide em { color: var(--color-ink-2); }
.guide hr { border: 0; border-top: 1px solid var(--color-rule-2); margin: 2.4em 0; }
.guide code, .guide .mono { font-family: var(--font-mono); font-size: .88em; }
.guide kbd { font-family: var(--font-mono); font-size: .85em; background: var(--color-surface); border: 1px solid var(--color-rule-2); padding: 1px 6px; }

/* A rule: the thing a player is promised. The one loud device on the page. */
.guide .rule {
  margin: 1.6em 0; padding: 18px 22px;
  border-left: 3px solid var(--color-gold); background: var(--color-frame);
  font-size: 1.08em; line-height: 1.5; max-width: var(--measure);
}
.guide .rule p { margin: 0; }
.guide .rule p + p { margin-top: .7em; }
.guide .rule strong { color: var(--color-gold); }

/* What the server can see — the honesty box. Quiet, grey, never gold. */
.guide .log {
  margin: 1.6em 0; padding: 16px 20px; background: var(--color-surface);
  border: 1px solid var(--color-rule-2); color: var(--color-ink-2); font-size: .95em; max-width: var(--measure);
}
.guide .log .t { display: block; color: var(--color-muted); font-size: .82em; margin-bottom: 6px; }
.guide .log p:last-child { margin-bottom: 0; }

/* Enforced by people — rust means an obligation, not a decoration. */
.guide .human {
  margin: 1.6em 0; padding: 16px 20px; border-left: 3px solid var(--color-rust);
  background: var(--color-frame); max-width: var(--measure);
}
.guide .human p:last-child { margin-bottom: 0; }

/* An announcement as the bot would post it. */
.guide .post {
  margin: 1.2em 0; padding: 14px 18px; background: var(--color-surface); border: 1px solid var(--color-rule-2);
  font-family: var(--font-mono); font-size: .86em; line-height: 1.5; max-width: var(--measure);
  overflow-x: auto;
}
.guide .post .ch { color: var(--color-muted); display: block; margin-bottom: 4px; font-size: .9em; }

.guide table { border-collapse: collapse; width: 100%; max-width: var(--measure); margin: 1.2em 0 1.6em; font-size: .95em; }
.guide .tablewrap { overflow-x: auto; max-width: var(--measure); }
.guide th, .guide td { text-align: left; vertical-align: top; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--color-rule-2); }
.guide th { color: var(--color-muted); font-weight: 400; font-size: .85em; }
.guide td:last-child, .guide th:last-child { padding-right: 0; }
.guide td.v { font-family: var(--font-mono); font-size: .9em; white-space: nowrap; color: #fff; }
.guide tr.group td { color: var(--color-gold); font-family: var(--font-display); padding-top: 22px; border-bottom-color: var(--color-rule-2); }

/* one-page rules list */
.guide .onepage h2 { font-size: 1.15em; margin-top: 2em; }
.guide .onepage ul { list-style: none; padding: 0; }
.guide .onepage li { padding: 8px 0; border-bottom: 1px solid var(--color-rule); margin: 0; }

/* prev / next — big, tappable, unmistakable */
.guide .pager {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--color-rule-2); max-width: var(--measure);
}
.guide .pager a {
  display: flex; flex-direction: column; justify-content: center; gap: 3px;
  min-height: 72px; padding: 14px 18px;
  background: var(--color-gold); color: var(--color-ground); border: 1px solid var(--color-gold);
}
.guide .pager a .lbl { font-family: var(--font-display); font-size: 17px; letter-spacing: .01em; }
.guide .pager a .dest { font-size: 14px; line-height: 1.3; opacity: .8; }
.guide .pager a:hover, .guide .pager a:focus-visible { background: #e6b04f; border-color: #e6b04f; text-decoration: none; }
.guide .pager a:hover .dest { opacity: 1; }
.guide .pager .prev { grid-column: 1; text-align: left; }
.guide .pager .next { grid-column: 2; text-align: right; align-items: flex-end; }
.guide .pager .empty { min-height: 72px; }

.guide footer.site { color: var(--color-dim); font-size: 13px; margin-top: 40px; max-width: var(--measure); }

@media (prefers-reduced-motion: no-preference) {
  .guide .topbar .menu { animation: guide-drop .12s ease-out; }
  @keyframes guide-drop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
}
```

- [ ] **Step 4: Write the contents list (client) and the layout**

```tsx
// apps/web/app/guide/contents.tsx
"use client";
import { usePathname } from "next/navigation";
import { CHAPTERS, hrefFor } from "@/lib/guide";

/**
 * The chapter list, twice per page (rail and top-bar menu). Client-side only
 * for `aria-current`: the layout is shared by every chapter and cannot know
 * which one is showing without the pathname.
 */
export default function Contents() {
  const here = usePathname();
  return (
    <nav aria-label="Chapters">
      <ul className="toc">
        {CHAPTERS.map((c) => (
          <li key={c.file}>
            {c.slug === "numbers" && <span className="sep" aria-hidden="true" style={{ display: "block" }} />}
            <a href={hrefFor(c)} aria-current={hrefFor(c) === here ? "page" : undefined}>
              <span className="n">{c.number}</span>
              <span>{c.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

⚠️ The old markup put the separator in its own `<li class="sep">`. Rendering it inside the appendix's `<li>` keeps the list valid and the CSS unchanged: `.toc .sep` only sets a border and margins.

```tsx
// apps/web/app/guide/layout.tsx
import "./guide.css";
import Contents from "./contents";

/**
 * The guide's chrome: the desktop rail, the phone top bar with its
 * <details> contents menu, and the reading column. Public and static —
 * nothing here depends on who is looking. The chapter pages fill <main>.
 */
export default function GuideLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="guide">
      <header className="topbar">
        <a className="brand" href="/guide"><img src="/guide/logo.png" alt="Clan Wars" width={40} height={40} /><span>Field Guide</span></a>
        <details><summary>Contents</summary><div className="menu"><Contents /></div></details>
      </header>
      <div className="shell">
        <aside className="rail"><div className="rail-inner">
          <a href="/guide"><img src="/guide/logo.png" alt="Clan Wars" width={120} height={120} /></a>
          <p className="kicker">Field Guide · one Xbox server, Livonia</p>
          <Contents />
        </div></aside>
        <main>{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the chapter renderer and the two pages**

```tsx
// apps/web/app/guide/chapter.tsx
import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_DIR, GUIDE_DESCRIPTION, hrefFor, neighbours, type Chapter } from "@/lib/guide";

export function chapterMetadata(c: Chapter): Metadata {
  return { title: `${c.number}. ${c.title} — DayZ Clan Wars Field Guide`, description: GUIDE_DESCRIPTION };
}

/**
 * One chapter: the opener from the manifest, the hand-written fragment, the
 * pager. ⚠️ The fragment is our own HTML from content/guide, read at build
 * time — not user input — which is the only reason dangerouslySetInnerHTML
 * is acceptable here.
 */
export default function ChapterPage({ chapter }: { chapter: Chapter }) {
  const html = readFileSync(join(CONTENT_DIR, chapter.file), "utf8");
  const { prev, next } = neighbours(chapter);
  return (
    <article className="page">
      <header className="opener"><span className="num">{chapter.number}</span><h1>{chapter.title}</h1><p className="lede">{chapter.lede}</p></header>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <nav className="pager" aria-label="Previous and next">
        {prev ? <a className="prev" href={hrefFor(prev)}><span className="lbl">&larr; Back</span><span className="dest">{prev.number}. {prev.title}</span></a> : <span className="prev empty" aria-hidden="true" />}
        {next ? <a className="next" href={hrefFor(next)}><span className="lbl">Next &rarr;</span><span className="dest">{next.number}. {next.title}</span></a> : <span className="next empty" aria-hidden="true" />}
      </nav>
      <footer className="site">DayZ Clan Wars · dayzclanwars.com</footer>
    </article>
  );
}
```

```tsx
// apps/web/app/guide/page.tsx
import { CHAPTERS } from "@/lib/guide";
import ChapterPage, { chapterMetadata } from "./chapter";

/** Chapter 1 lives at the bare /guide. Public and static (spec §10.2). */
export const metadata = chapterMetadata(CHAPTERS[0]!);

export default function GuideIndex() {
  return <ChapterPage chapter={CHAPTERS[0]!} />;
}
```

```tsx
// apps/web/app/guide/[slug]/page.tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CHAPTERS, chapterBySlug } from "@/lib/guide";
import ChapterPage, { chapterMetadata } from "../chapter";

type Params = { params: Promise<{ slug: string }> };

/** Every chapter is generated at build time; an unknown slug is a 404, never a filesystem read. */
export const dynamicParams = false;

export function generateStaticParams() {
  return CHAPTERS.filter((c) => c.slug !== "").map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const c = chapterBySlug((await params).slug);
  return c ? chapterMetadata(c) : {};
}

export default async function GuideChapter({ params }: Params) {
  const c = chapterBySlug((await params).slug);
  if (!c || c.slug === "") notFound();
  return <ChapterPage chapter={c} />;
}
```

- [ ] **Step 6: Run the tests, typecheck and a build**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts && pnpm --filter @factions/web typecheck && pnpm --filter @factions/web build`
Expected: tests PASS; typecheck clean; the build's route list shows `/guide` and `/guide/[slug]` as static (`○` or `●`) with 13 generated paths.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/guide apps/web/test/guide.test.ts
git commit -m "feat(guide): render the field guide at /guide from apps/web"
```

---

### Task 3: Remove the redirect and repoint everything that named the old host

**Files:**
- Modify: `apps/web/next.config.ts` (drop the import and `redirects()`)
- Delete: `apps/web/test/guide-redirect.test.ts`
- Modify: `apps/web/lib/auth/gate.ts:8,19-23` (comments only)
- Modify: `scripts/guide-numbers.ts:2-5,19,32`
- Regenerate: `docs/guide-numbers.json`
- Modify: `packages/domain/src/rules.ts:3`
- Modify: `CLAUDE.md:232,575`
- Modify: `apps/web/README.md` (one sentence in "What this is today")
- Modify: `apps/web/test/guide.test.ts` (add the no-redirects test)

- [ ] **Step 1: Add the failing test**

Append to `apps/web/test/guide.test.ts`:

```ts
import config from "../next.config";

describe("the site serves the guide itself", () => {
  it("has no redirects — /guide used to hand off to fieldguide.dayzclanwars.com", () => {
    expect(config.redirects).toBeUndefined();
  });
});
```

(Move the import to the top of the file with the others.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts`
Expected: FAIL — `redirects` is a function.

- [ ] **Step 3: Edit next.config.ts and delete the redirect test**

Remove `import { GUIDE_URL } from "./lib/guide";` and the whole `// \`/guide\` is the field guide …` comment plus `async redirects() {…}` block. Then:

```bash
git rm apps/web/test/guide-redirect.test.ts
```

- [ ] **Step 4: Repoint the gate comments**

In `apps/web/lib/auth/gate.ts` replace the `/guide/` sentence in the `PUBLIC_PREFIXES` comment with:

```
 * `/guide/` is the field guide's chapters (`app/guide/[slug]`), served by
 * this app since 2026-09-07 — before that every subpath was a permanent
 * redirect to the guide's own host.
```

- [ ] **Step 5: Repoint the numbers script and regenerate the JSON**

In `scripts/guide-numbers.ts`:
- header comment: `pnpm guide:numbers            # reads apps/web/content/guide/numbers.html, relative to the repo root`
- `const src = process.argv[2] ?? resolve(ROOT, "apps", "web", "content", "guide", "numbers.html");`
- `const out = { source: "apps/web/content/guide/numbers.html", … }`

Then:

```bash
pnpm guide:numbers
git diff --stat docs/guide-numbers.json
git diff docs/guide-numbers.json | grep '^[-+]' | grep -v 'source\|generatedAt\|^+++\|^---'
```

Expected: the second command prints nothing — only `source` and `generatedAt` changed.

- [ ] **Step 6: Repoint the prose**

- `packages/domain/src/rules.ts:3`: `(../field-guide/numbers.html)` → `(apps/web/content/guide/numbers.html)`.
- `CLAUDE.md:232`: the row becomes `| The player's guide (the authority over every rule) | \`apps/web/content/guide/\` (fragments) and \`apps/web/lib/guide.ts\` (chapter manifest) — served at dayzclanwars.com/guide. Moved in from the archived field-guide repo on 2026-09-07. |`
- `CLAUDE.md:575`: after "`/guide` redirects to the guide's host," add " (superseded 2026-09-07: the guide now lives in `apps/web`)".
- `apps/web/README.md`, "What this is today": add `Public, static: \`/guide\` — the field guide, rendered from hand-written HTML fragments in \`content/guide/\` (\`lib/guide.ts\` is the chapter manifest).`

- [ ] **Step 7: Run the web tests and the domain drift test**

Run: `pnpm --filter @factions/web test && pnpm --filter @factions/domain exec vitest run test/guide-numbers-drift.test.ts`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add -A apps/web/next.config.ts apps/web/test apps/web/lib/auth/gate.ts scripts/guide-numbers.ts docs/guide-numbers.json packages/domain/src/rules.ts CLAUDE.md apps/web/README.md
git commit -m "feat(guide): drop the redirect to the old host; repoint the numbers script and docs"
```

---

### Task 4: Verification

- [ ] **Step 1: The full gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: 26/26 tasks successful. Check the count, not the exit code.

- [ ] **Step 2: Browser check**

```bash
pnpm --filter @factions/web build && (cd apps/web && PORT=3123 pnpm start &)
```

Open `http://localhost:3123/guide`, `/guide/bases`, `/guide/numbers` at a desktop width (rail visible, current chapter gold) and at 390px (top bar, contents menu opens). Confirm the fonts are Archivo/Space Mono, gold rule boxes, pager buttons, `/guide/nope` is a 404. Stop the server.

- [ ] **Step 3: Note in the plan and hand off**

Nothing further to commit. Remaining for the operator: archive `dayz-clan-wars/field-guide` on GitHub and delete the `fieldguide` DNS record.
