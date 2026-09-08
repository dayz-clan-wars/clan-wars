# The guide, integrated

Date: 2026-09-07. Status: approved in conversation. Follows
`2026-09-07-field-guide-in-the-web-app-design.md` (the move) and the
Dispatch redesign (`feat/redesign`, merged 2026-09-07).

## Why

The guide lives in the app now but still reads as a guest: its own
stylesheet, its own chrome, numbers typed by hand and held to `rules.ts` by a
drift test, no way in from the pages that need it, no way to link to a
section. Four changes, one branch.

## 1. Cross-links

`apps/web/lib/guide-links.ts` exports `GUIDE_LINKS: Record<string, { slug: string; heading?: string }>`
keyed by route pattern, and `guideLinkFor(route)` returning
`{ href, label }` (`label` = "N. Title", or "N. Title › Heading"). `PageHead`
takes `guide?: { href, label }` and renders "In the guide: … →" in the mono
voice, right-aligned above the aside on desktop, under the sub line on phones.

| Route | Chapter › heading |
|---|---|
| `/base` | Bases |
| `/link`, `/login`, `/join` | Getting in |
| `/me` | What this is |
| `/clan` | Running a clan |
| `/clan/settings` | Running a clan › Rename |
| `/clan/vault` | Running a clan › The Vault |
| `/clan/board`, `/players`, `/players/[gamertag]` | The scoreboard › Player boards |
| `/clans` | Running a clan › Recruiting post |
| `/clans/[tag]` | Running a clan › Joining |
| `/claim/[ceremony]` | Founding a clan › The claim |
| `/scoreboard` | The scoreboard › Points |
| `/alphas` | The scoreboard › The week |
| `/seasons` | The scoreboard › The season |
| `/war-log` | Raiding |
| `/map` | The map |

Inline links in four refusals: not-linked on `/base`, `/clan`, `/map` → Getting
in; `too-close` on `/base` (base-copy's DECLARE_COPY) → Bases › Spacing. Copy
strings stay strings; the link is rendered beside the notice by the page.

Test: every entry's slug is a chapter and every heading is an `<h2>` in that
chapter's fragment (by generated id).

## 2. Guide on the site's components

- `app/guide/layout.tsx`: SiteBar (unchanged) + a `GuideRail` (server) with
  `GuideSearch` (client) and `Contents` (client) — the same `Contents` renders
  in the phone menu.
- `app/guide/chapter.tsx`: opener = the numeral + uppercase title + lede on
  Tailwind classes; the fragment inside `<div className="prose-guide">`; the
  pager as a bordered pair; footer line.
- `app/guide/guide.css` keeps ONLY `.prose-guide` rules: h2/h3/p/ul/ol/li/
  strong/em/hr/code/kbd/table, `.rule`, `.log`, `.human`, `.post`, `.onepage`,
  and the heading anchor. No layout, no rail, no pager, no opener.
- `test/guide.test.ts` keeps the token checks and now asserts the stylesheet
  has no `.rail`, `.pager`, `.opener`, `.toc`, `.menu` selectors.

## 3. Numbers from code

`packages/domain/src/guide-numbers.ts`:

```ts
export type GuideNumber = { key: string; group: string; label: string; value: string };
export const GUIDE_NUMBERS: readonly GuideNumber[];   // the appendix, in order
export function guideNumber(key: string, format?: Format): string; // for tokens
export type Format = "days" | "hours" | "minutes" | "h" | "min" | "m" | "n";
```

`GUIDE_NUMBERS` is the drift test's `EXPECTED` map moved into source, with
the group headings the appendix already has. `guideNumber("FLAG_DOWN_MS",
"hours")` → "24 hours"; `"h"` → "24 h"; `"n"` → the bare number; a key without
a format renders the appendix value. Unknown key or a format that does not fit
the key's unit throws.

Fragments: `{{KEY}}` / `{{KEY|format}}`. `app/guide/render.ts` exports
`renderFragment(html): { html, headings: {id, text}[] }` which substitutes
tokens (throwing on an unknown one), adds `id` and an anchor to every `<h2>`,
and returns the heading list. Both the chapter page and the search index use it.

`content/guide/numbers.html` is deleted; `app/guide/[slug]/page.tsx` renders
the appendix from `GUIDE_NUMBERS` when `slug === "numbers"` (the manifest entry
stays, with `file: null`).

Removed: `docs/guide-numbers.json`, `scripts/guide-numbers.ts`, the
`guide:numbers` script, `packages/domain/test/guide-numbers-drift.test.ts`.
Added: `packages/domain/test/guide-numbers.test.ts` (every key resolves; the
appendix has the same 49 rows the JSON had, pinned as a snapshot of labels;
formats reject the wrong unit) and, in `apps/web/test/guide.test.ts`, that no
fragment contains a raw literal equal to any tokenizable value in any format
(the new drift guard), and that every token resolves.

CLAUDE.md: the "guide numbers, vendored" row and the "every guide number lives
in rules.ts" paragraph are rewritten.

## 4. Search and deep links

- Heading ids: `slugify(text)`; duplicates within a chapter get `-2`, `-3`.
  The anchor is `<a class="anchor" href="#id" aria-label="Link to this section">#</a>`;
  a tiny client script copies the URL on click (progressive: the href works
  without it).
- `app/guide/index.ts`: `buildIndex(): SearchEntry[]` where
  `SearchEntry = { chapter, number, slug, heading?, id?, href, text }`, `text`
  the first paragraph after the heading, tags stripped, ≤ 160 chars. Built on
  the server and passed to `GuideSearch` as props.
- `GuideSearch` (client): an input; on ≥ 2 characters, case-insensitive
  substring match on `${chapter} ${heading} ${text}`; up to 12 results as
  "Chapter › heading" links. Escape clears. Placed in the guide rail, the phone
  Contents menu, and the site drawer (drawer gets the index too — it is a few
  KB).
- Test: index has one entry per chapter plus one per `<h2>`; ids unique per
  chapter; `hrefs` resolve to real chapters.

## Verification

Full gate (task count changes: −1 domain test file, +1), `next build`, local
render of `/guide`, a chapter with tokens, `/guide/numbers`, a page with a
guide link, and the search box; then the live site.
