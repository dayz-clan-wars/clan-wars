# The field guide inside the web app

Date: 2026-09-07. Status: approved in conversation.

## Why

The guide is the authority over every rule, and until now it lived in its own
repo (`../field-guide/`), published by GitHub Pages at
fieldguide.dayzclanwars.com, with dayzclanwars.com/guide a permanent redirect.
Two hosts, two stylesheets stating one palette, fonts from Google's CDN on one
side and self-hosted on the other. The guide moves into `apps/web` so there is
one site, one design system, and one repo to keep the numbers honest in.

## Decisions

- **Content form:** each chapter's body stays hand-written HTML, as a fragment
  file. A React shell renders the chrome. No MDX, no rewrite.
- **URLs:** clean slugs. `/guide` is chapter 1, `/guide/<slug>` the rest,
  `/guide/numbers` the appendix. The old host is not redirected; the
  GitHub repo is archived and the DNS record deleted by hand afterwards.
- **History:** files are copied. The field-guide repo's commits stay there.

## Layout

    apps/web/content/guide/
      01-what-this-is.html      # fragment: inside of <article>, minus opener, pager, footer
      02-getting-in.html
      …
      13-rules-on-one-page.html
      numbers.html              # the table; pnpm guide:numbers reads this
    apps/web/lib/guide.ts       # CHAPTERS manifest (replaces GUIDE_URL)
    apps/web/app/guide/layout.tsx   # rail + topbar + main column
    apps/web/app/guide/page.tsx     # chapter 1
    apps/web/app/guide/[slug]/page.tsx
    apps/web/app/guide/chapter.tsx  # opener + fragment + pager, shared by both pages
    apps/web/app/guide/guide.css    # the old stylesheet, scoped, on @theme tokens
    apps/web/public/guide/logo.png

### Manifest

`CHAPTERS: readonly Chapter[]`, in reading order, where
`Chapter = { slug, number: string, title, lede, description, file }`.
`number` is a string because the appendix is "A". `slug` for chapter 1 is
`""`, so `/guide` and `hrefFor(chapter)` compose without a special case.
A `chapterBySlug(slug)` helper returns `undefined` for anything unknown.

### Rendering

Both pages call `generateStaticParams` / are static: the guide depends on
nobody's session. `[slug]` sets `dynamicParams = false`, so an unknown slug is
a 404 and nothing reads the filesystem at request time. Fragments are read with
`readFileSync` from `process.cwd()`-relative paths at build time and injected
with `dangerouslySetInnerHTML`; the content is ours, not user input.

Per-page `metadata`: title `"<number>. <title> — DayZ Clan Wars Field Guide"`,
description from the manifest.

### Shell

The layout is the markup every chapter repeats today: a `<header class="topbar">`
with the brand link and a `<details>` contents menu, and a `<div class="shell">`
with the `<aside class="rail">` and `<main>`. `aria-current="page"` on the
active chapter needs the pathname, so the contents list is a small client
component using `usePathname`; everything else is a server component.

### Styling

`guide.css` is the old `assets/style.css` with:

- every `var(--ink)`-style token replaced by the app's `var(--color-ink)` etc.,
  and the `:root` palette block deleted (theme-tokens.test.ts forbids a second
  statement of the palette anywhere near globals.css; this file states none);
- `--font-*` read from `@theme` — the same names already exist there;
- element selectors (`h2`, `p`, `table`, …) scoped under `.guide` so they do
  not restyle the rest of the site;
- the Google Fonts `<link>` gone; `app/fonts.ts` already self-hosts the faces.

## Removed and repointed

- `next.config.ts`: the `redirects()` block goes. `test/guide-redirect.test.ts`
  goes with it.
- `lib/auth/gate.ts`: `/guide` and `/guide/` stay in the public lists; their
  comments now describe real routes, not redirects.
- `scripts/guide-numbers.ts`: default input becomes
  `apps/web/content/guide/numbers.html`. `docs/guide-numbers.json` is
  regenerated and its rows must be unchanged.
- `CLAUDE.md` "Where things live" and `packages/domain/src/rules.ts`'s header
  comment point at the new path.
- The landing page's "Read the field guide" link is unchanged (`/guide`).

## Tests

`apps/web/test/guide.test.ts`:

1. The manifest has 14 entries, unique slugs, chapter 1 has slug `""`, the
   last entry is `numbers`.
2. Every `file` exists under `content/guide/`.
3. No fragment contains `href="…\.html` or `<script`.
4. `guide.css` declares no `--color-*` or `--font-*` token and does not
   reference any bare `var(--ink)`-style token that `@theme` does not define.
5. `next.config.ts` exports no `redirects`.

Existing coverage that keeps holding: `packages/domain/test/guide-numbers-drift.test.ts`
(the table against `rules.ts`), `test/auth-gate.test.ts` (the public lists).

## Verification

The full turbo gate (26/26), `pnpm --filter @factions/web build`, and a browser
pass over `/guide`, one chapter and `/guide/numbers` at desktop and phone widths.

## Out of scope

Redirecting the old host; a site favicon; shared site chrome beyond the guide.
