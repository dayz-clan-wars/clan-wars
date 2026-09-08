# Guide Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the field guide a first-class part of the site: numbers from `rules.ts`, chrome from the shared primitives, links in from every page, search and deep links.

**Architecture:** `packages/domain/src/guide-numbers.ts` becomes the single statement of every public number (appendix + prose tokens). `apps/web/app/guide/render.ts` turns a fragment into HTML with tokens substituted and headings anchored, and the same pass feeds a build-time search index. Page chrome moves onto `app/components/ui.tsx`; `guide.css` keeps prose only. `lib/guide-links.ts` maps routes to chapters for the page heads.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4, vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-guide-integration-design.md`

## Global Constraints

- No chapter wording changes; only numbers become tokens.
- Copy strings in `lib/*-copy.ts` stay plain strings (their tests pin them).
- `test/theme-tokens.test.ts`: `guide.css` declares no `--color-*`/`--font-*`.
- Commit messages end with the session trailers.

---

### Task 1: `guide-numbers.ts` in the domain package (TDD)
**Files:** Create `packages/domain/src/guide-numbers.ts`, `packages/domain/test/guide-numbers.test.ts`; export from `packages/domain/src/index.ts`; delete `packages/domain/test/guide-numbers-drift.test.ts`, `docs/guide-numbers.json`, `scripts/guide-numbers.ts`, the root `guide:numbers` script.
**Produces:** `GUIDE_NUMBERS`, `guideNumber(key, format?)`, `GUIDE_GROUPS` (group order), `Format`.
- [ ] Test: 49 rows with the JSON's labels in order; `guideNumber("FLAG_DOWN_MS","hours")==="24 hours"`, `"h"→"24 h"`, `"n"→"24"`; `guideNumber("WATCH_ZONE_RADIUS_M","m")==="100 m"`; unknown key throws; `"days"` on a metres key throws; every row's `key` resolves.
- [ ] Implement; run domain tests; commit.

### Task 2: `render.ts` — tokens, heading ids, anchors (TDD)
**Files:** Create `apps/web/app/guide/render.ts`, extend `apps/web/test/guide.test.ts`.
**Produces:** `renderFragment(html) → { html, headings }`, `slugify`.
- [ ] Test: `{{FLAG_DOWN_MS|hours}}` → `24 hours`; unknown token throws; `<h2>The claim</h2>` → `<h2 id="the-claim">The claim<a class="anchor" href="#the-claim" …>#</a></h2>`; duplicate headings get `-2`; headings list returned.
- [ ] Implement; commit.

### Task 3: Tokenise the fragments; appendix from code
**Files:** Modify `content/guide/*.html` (script + read-through), delete `content/guide/numbers.html`; `lib/guide.ts` (`file: string | null`), `app/guide/chapter.tsx` (appendix branch), `app/guide/[slug]/page.tsx`.
- [ ] Add to `guide.test.ts`: every token in every fragment resolves; no fragment contains a raw literal equal to `guideNumber(key, f)` for any key/format that has a token (the drift guard) — run, expect failures listing the literals.
- [ ] Script the substitutions from the failure list; hand-check the diff; run until green; commit.

### Task 4: Guide chrome on the primitives; prose-only CSS
**Files:** `app/guide/layout.tsx`, `app/guide/chapter.tsx`, `app/guide/contents.tsx`, `app/guide/guide.css`, `guide.test.ts` (no layout selectors).
- [ ] Rewrite; keep `.prose-guide` rules only; typecheck; commit.

### Task 5: Search index + `GuideSearch` + anchor copy
**Files:** Create `app/guide/index.ts`, `app/guide/search.tsx`, `app/guide/anchors.tsx` (client, copies URL on `.anchor` click); wire into layout rail, Contents menu, and `app/(site)/menu-list.tsx` drawer (index passed from `(site)/layout.tsx` via `site-bar.tsx`).
- [ ] Test (`guide.test.ts`): index = 14 chapters + Σ h2; ids unique per chapter; hrefs resolve.
- [ ] Implement; commit.

### Task 6: Cross-links
**Files:** Create `lib/guide-links.ts`, `test/guide-links.test.ts`; `app/components/ui.tsx` (`PageHead.guide`); every page in the spec table; inline links on `/base`, `/clan`, `/map` not-linked and `too-close`.
- [ ] Test: every mapped slug/heading exists (uses `renderFragment` headings).
- [ ] Implement; commit.

### Task 7: Docs + verification
- [ ] CLAUDE.md rows/paragraph; `apps/web/README.md`.
- [ ] Full gate, build, local render (see memory `web-local-render`), live check after deploy.
