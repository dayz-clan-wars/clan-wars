# Shell & Public Pages UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding (H1–H5, M1–M12, L1–L8, S1) from the 2026-09-24 UX review of the site shell and the public pages, each pinned by a test.

**Architecture:** Every fix stays inside `apps/web`. Shared behaviour goes into the existing primitives: `ui.tsx` (SegNav), the shell components, and two small new modules (`lib/popover.ts`, `lib/page-titles.ts`). Row markup that has to be tested moves out of the async, database-backed page files into plain components (`app/components/score-rows.tsx`, `app/(site)/clans/rows.tsx`, `WarLogDays` in `war-log/entry.tsx`). A Next page file may export only its route members, and a static render of an extracted component needs no database. Flag thumbnails are generated once by hand from the committed PNGs and committed, following `scripts/fetch-flags.ts` / `scripts/fetch-item-images.ts`, with an asset test in the same style as `flag-assets.test.ts`.

**Tech Stack:** Next.js 16 (App Router, RSC), React 19, Tailwind v4 (`@theme` tokens in `app/globals.css`), vitest 2 with `renderToStaticMarkup`, sharp 0.35 (devDependency), TypeScript 5.6.

**Spec:** UX review of 2026-09-24. The findings list is reproduced in this plan's appendix, and each task cites its finding ids.

All paths below are relative to the repo root unless they start with `apps/web/`'s own folders inside a `cd apps/web` command. Line numbers are as of `3cb39d1`. Later tasks edit files that earlier tasks already changed, so every edit is written as an exact old→new snippet. Match on the snippet, not the line number.

---

## Global Constraints

- Colours come only from the `@theme` tokens in `apps/web/app/globals.css`. `test/theme-tokens.test.ts` guards them, so a new token needs a row there. This plan adds none.
- `--color-rust` means an outstanding obligation and is used for edges only. For rust-coloured text use `--color-rust-2`, which is 5:1; `--color-rust` is only 2.6:1.
- No meaningful text below 11px.
- Every touch target is at least 44×44 CSS px.
- Add ⚠️ WHY-comments wherever a line is load-bearing, and match the comment density of the file you are editing.
- Web source never contains the substring "faction", identifiers included (`test/copy-vocabulary.test.ts`).
- Every guide number goes through `packages/domain/src/rules.ts` → `guide-numbers.ts` tokens and is never a literal (`test/guide.test.ts`). Tests that need a rule number import it, for example `CLAN_NAME_LENGTH.max`.
- Base and pole coordinates are never rendered.
- Packages that web transpiles use extensionless relative imports. `apps/web/scripts/*` keep their existing `../src/x.js` form.
- `/` and `/guide` must stay outside the `(site)` group layout, and the top of `app/` stays exactly `(site)`, `api`, `components`, `guide` (`test/menu.test.ts`). New components go in `app/components/` or beside their route.
- Tailwind's `lg` is 1024px. Any JavaScript media query that mirrors a Tailwind breakpoint says so in a ⚠️ comment.
- Stay out of the sibling plans' files. The MAP plan owns `app/(site)/map/**` and `lib/map-*`. The FORMS plan owns confirm-button, notice, sign-in-card, gamertag-field, next-step, own-clan-hero, achievement-toast, the signed-in pages (login, link, join, base, claim, kit, the notifications PAGE, clan, clan/settings, clan/vault, clan/board), and "rust used for refusals". `app/components/notice-row.tsx` is edited here only for its type size (M7, the bell panel's rows), not for colour.

## Review Focus

These are the five failure modes most likely to reach a player that no existing test exercises. Each one has a test in the task named.

1. **A 32-character clan name with no spaces at 375px.** `CLAN_NAME_LENGTH.max` in Archivo Black at 15px is about 350px wide. As a flex item without `min-w-0` it pushes the member count or the points off-screen. Covered by Task 13 (`/scoreboard` phone rows) and Task 15 (`/clans` rows), which render `"W".repeat(CLAN_NAME_LENGTH.max)`.
2. **Season 5 in the scope picker.** Six cells in one row overflow a phone, and a cell with `flex-1` (basis 0) never wraps however narrow the row is. Covered by Task 2, which renders five seasons, asserts wrap with no `flex-1`, and asserts Season 5 is marked current.
3. **Two popovers open at once.** Menu, bell and Contents are all at `z-[1300]` and stack illegibly. Covered by Task 1: one `name` group across all three `<details>`, plus the pure open-one-close-others and click-outside rules.
4. **A flag with no thumbnail.** A texture added to `CLAIMABLE_FLAGS` without re-running the thumbnail script is a broken image in every list, and nothing else would notice. Covered by Task 3, which checks every claimable flag has a thumbnail, there are no orphans, the size is exact, and the thumbnail path is public.
5. **Award times rendered in the viewer's own zone.** The server renders in UTC, the browser in Auckland, and hydration swaps the text. Covered by Task 10, which renders the award page under two different `TZ` values and requires identical output.

---

### Task 1: Popovers stay on screen, and only one is open at a time (H1, L3)

**Files:**
- Create: `apps/web/lib/popover.ts`
- Create: `apps/web/app/components/popover-dismiss.tsx`
- Modify: `apps/web/app/components/notifications-bell.tsx:4-18,25,38`
- Modify: `apps/web/app/(site)/menu-list.tsx:1-2,52-81`
- Modify: `apps/web/app/(site)/site-bar.tsx:1-5,29-44`
- Modify: `apps/web/app/guide/layout.tsx:1-12,46-48`
- Test: `apps/web/test/popover.test.ts`

**Interfaces:**
- Produces: `POPOVER_GROUP: "cw-popover"`, `othersThan<T>(open: readonly T[], opened: T): T[]`, `toDismiss<T extends { contains(node: unknown): boolean }>(open: readonly T[], target: unknown): T[]` (all from `lib/popover.ts`), and `PopoverDismiss(): null` (client component).
- Consumes: `--spacing-bar` (globals.css, 52px).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/popover.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsBell } from "../app/components/notifications-bell";
import { POPOVER_GROUP, othersThan, toDismiss } from "../lib/popover";

const APP = join(import.meta.dirname, "..", "app");
const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");
const bell = renderToStaticMarkup(createElement(NotificationsBell, { unread: 0, recent: [] }));

/**
 * H1 (2026-09-24, confirmed live at 375px): the bell's panel hung `right-0`
 * off a bell that sits LEFT of Menu, so its first ~55px were off the screen;
 * the guide's Contents did the same. Below lg both now pin to the viewport.
 */
describe("the bar's popovers on a phone", () => {
  it("⚠️ the bell's panel is pinned to the viewport below lg, and anchored to the bell only from lg", () => {
    expect(bell).toMatch(/class="fixed inset-x-3 top-\[calc\(var\(--spacing-bar\)\+8px\)\][^"]*lg:absolute lg:inset-x-auto lg:right-0/u);
    expect(bell).not.toContain("w-[340px]");
  });

  it("offsets from --spacing-bar, never a hand-typed bar height (L3)", () => {
    expect(bell).not.toContain("top-[54px]");
    expect(read("(site)", "menu-list.tsx")).not.toContain("top-[60px]");
    expect(read("(site)", "menu-list.tsx")).toContain("top-[calc(var(--spacing-bar)+8px)]");
  });

  it("the guide's Contents panel is pinned the same way", () => {
    const layout = read("guide", "layout.tsx");
    expect(layout).toContain("fixed inset-x-3 top-[calc(var(--spacing-bar)+8px)]");
    expect(layout).not.toContain("absolute right-0 top-[calc(100%+8px)]");
  });
});

describe("one popover at a time", () => {
  it("⚠️ Menu, the bell and Contents share one exclusive <details> group", () => {
    expect(bell).toContain(`name="${POPOVER_GROUP}"`);
    expect(read("(site)", "menu-list.tsx")).toMatch(/<details[^>]*name=\{POPOVER_GROUP\}/u);
    expect(read("guide", "layout.tsx")).toMatch(/<details[^>]*name=\{POPOVER_GROUP\}/u);
  });

  it("the bar mounts the one dismiss handler", () => {
    expect(read("(site)", "site-bar.tsx")).toMatch(/<PopoverDismiss\s*\/>/u);
  });

  it("opening one closes every other", () => {
    const menu = { id: "menu" }, bellPanel = { id: "bell" }, contents = { id: "contents" };
    expect(othersThan([menu, bellPanel, contents], bellPanel)).toEqual([menu, contents]);
  });

  it("a click closes the open ones that do not contain it, and keeps the one it landed in", () => {
    const inside = { contains: (n: unknown) => n === "target" };
    const outside = { contains: () => false };
    expect(toDismiss([inside, outside], "target")).toEqual([outside]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/popover.test.ts`
Expected: FAIL. The import `../lib/popover` cannot be resolved. Once that file exists, the bell assertions fail on `w-[340px]` / `top-[54px]`.

- [ ] **Step 3: Implement**

Create `apps/web/lib/popover.ts`:

```ts
/**
 * The top bar's three popovers — the phone Menu drawer (menu-list.tsx), the
 * bell's panel (notifications-bell.tsx) and the guide's Contents
 * (app/guide/layout.tsx) — are one group: opening one closes the others.
 *
 * ⚠️ All three paint at z-[1300]; two open at once stack into something
 * nobody can read or dismiss. `name` on a <details> makes the group
 * exclusive natively in current browsers; `PopoverDismiss` enforces the same
 * rule for the ones that predate it, and adds Escape and click-outside.
 */
export const POPOVER_GROUP = "cw-popover";

/** When `opened` opens, the rest of the group closes. */
export function othersThan<T>(open: readonly T[], opened: T): T[] {
  return open.filter((d) => d !== opened);
}

/** Which open popovers a click at `target` closes: every one that does not contain it. */
export function toDismiss<T extends { contains(node: unknown): boolean }>(open: readonly T[], target: unknown): T[] {
  return open.filter((d) => !d.contains(target));
}
```

Create `apps/web/app/components/popover-dismiss.tsx`:

```tsx
"use client";
import { useEffect } from "react";
import { POPOVER_GROUP, othersThan, toDismiss } from "@/lib/popover";

/**
 * Escape, a click outside, and one-at-a-time for every <details> in the
 * bar's popover group (lib/popover.ts). Mounted once, by SiteBar, so the
 * drawer, the bell and Contents all behave the same way instead of each
 * carrying its own listeners.
 */
export function PopoverDismiss() {
  useEffect(() => {
    const open = () => [...document.querySelectorAll<HTMLDetailsElement>(`details[name="${POPOVER_GROUP}"][open]`)];
    const close = (ds: HTMLDetailsElement[]) => ds.forEach((d) => d.removeAttribute("open"));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of open()) {
        // Hand focus back to the summary, or a keyboard user is left on a node that just vanished.
        const had = d.contains(document.activeElement);
        d.removeAttribute("open");
        if (had) d.querySelector("summary")?.focus();
      }
    };
    const onClick = (e: MouseEvent) => close(toDismiss(open(), e.target as Node));
    // ⚠️ `toggle` does not bubble, so this listens in the CAPTURE phase, which still sees it at the document.
    const onToggle = (e: Event) => {
      const d = e.target;
      if (d instanceof HTMLDetailsElement && d.open && d.getAttribute("name") === POPOVER_GROUP) close(othersThan(open(), d));
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    document.addEventListener("toggle", onToggle, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
      document.removeEventListener("toggle", onToggle, true);
    };
  }, []);
  return null;
}
```

In `apps/web/app/components/notifications-bell.tsx`:

Replace the imports (lines 1-2) with:

```tsx
import type { NoticeRow } from "@factions/roster";
import { POPOVER_GROUP } from "@/lib/popover";
import { NoticeArticle } from "./notice-row";
```

Replace the doc comment's middle paragraph (lines 7-12, "A `<details>`, like the phone drawer … is enough on its own.") with:

```tsx
 * A `<details>`, like the phone drawer in menu-list.tsx, so it opens without
 * JavaScript and closes on navigation. It is in the bar's popover group
 * (lib/popover.ts): opening it closes Menu or Contents, and Escape and a
 * click outside close it (PopoverDismiss, mounted by SiteBar).
 *
 * ⚠️ Below lg the panel is FIXED to the viewport, not hung off the bell: the
 * bell sits left of Menu, so a `right-0` panel ran ~55px off the left edge of
 * a 375px phone (2026-09-24, H1). From lg it is anchored under the bell again.
```

Replace line 25:

```tsx
    <details className="group relative flex items-stretch border-l border-rule-2">
```

with:

```tsx
    <details name={POPOVER_GROUP} className="group relative flex items-stretch border-l border-rule-2">
```

Replace line 38:

```tsx
      <div className="absolute right-0 top-[54px] z-[1300] w-[340px] max-w-[calc(100vw-24px)] border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)] lg:w-[400px]">
```

with:

```tsx
      <div className="fixed inset-x-3 top-[calc(var(--spacing-bar)+8px)] z-[1300] max-h-[calc(100dvh-var(--spacing-bar)-16px)] overflow-y-auto border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)] lg:absolute lg:inset-x-auto lg:right-0 lg:top-[calc(var(--spacing-bar)+2px)] lg:max-h-none lg:w-[400px]">
```

In `apps/web/app/(site)/menu-list.tsx`:

Replace lines 1-2:

```tsx
"use client";
import { useEffect, useRef } from "react";
```

with:

```tsx
"use client";
import { useRef } from "react";
import { POPOVER_GROUP } from "@/lib/popover";
```

Replace the Drawer's comment and the start of its body (lines 52-74, from `/**` through `<details ref={root} className="group">`):

```tsx
/**
 * The phone drawer: a <details> so it works without JavaScript and closes on
 * navigation; this adds Escape, click-outside, and the dimmed backdrop. The
 * summary reads "Menu" closed and "Close" open, filled gold when open.
 */
export function Drawer({ signedIn, guideIndex, counts = { you: 0, clan: 0 } }: { signedIn: boolean; guideIndex?: SearchEntry[]; counts?: Counts }) {
  const { pathname, here } = useHere();
  const root = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = root.current;
    if (!details) return;
    const close = () => details.removeAttribute("open");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onClick = (e: MouseEvent) => { if (!details.contains(e.target as Node)) close(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("click", onClick); };
  }, []);

  const item = "flex min-h-[48px] items-center justify-between px-5 font-display text-sm uppercase tracking-[0.06em]";
  return (
    <details ref={root} className="group">
```

with:

```tsx
/**
 * The phone drawer: a <details> so it works without JavaScript and closes on
 * navigation, with a dimmed backdrop. The summary reads "Menu" closed and
 * "Close" open, filled gold when open. Escape, click-outside and
 * one-popover-at-a-time come from PopoverDismiss (mounted by SiteBar) for the
 * whole popover group, so the drawer no longer carries listeners of its own.
 */
export function Drawer({ signedIn, guideIndex, counts = { you: 0, clan: 0 } }: { signedIn: boolean; guideIndex?: SearchEntry[]; counts?: Counts }) {
  const { pathname, here } = useHere();
  const root = useRef<HTMLDetailsElement>(null);

  const item = "flex min-h-[48px] items-center justify-between px-5 font-display text-sm uppercase tracking-[0.06em]";
  return (
    <details ref={root} name={POPOVER_GROUP} className="group">
```

Replace line 81's opening tag:

```tsx
      <nav aria-label="Site" className="absolute right-3 top-[60px] z-[1300] max-h-[calc(100dvh-72px)] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)]">
```

with:

```tsx
      <nav aria-label="Site" className="absolute right-3 top-[calc(var(--spacing-bar)+8px)] z-[1300] max-h-[calc(100dvh-var(--spacing-bar)-20px)] w-[300px] max-w-[calc(100vw-24px)] overflow-y-auto border-2 border-rule-2 bg-frame shadow-[0_16px_40px_rgba(0,0,0,.6)]">
```

In `apps/web/app/(site)/site-bar.tsx`, add the import after line 4:

```tsx
import { PopoverDismiss } from "@/app/components/popover-dismiss";
```

and replace lines 39-43:

```tsx
      <div className="flex items-center gap-2 lg:hidden">
        {extra}
        {signedIn && notifications && <NotificationsBell {...notifications} />}
        <Drawer signedIn={signedIn} guideIndex={guideIndex} counts={counts} />
      </div>
```

with:

```tsx
      <div className="flex items-center gap-2 lg:hidden">
        {extra}
        {signedIn && notifications && <NotificationsBell {...notifications} />}
        <Drawer signedIn={signedIn} guideIndex={guideIndex} counts={counts} />
      </div>
      {/* One handler for the whole popover group (lib/popover.ts): Escape, click-outside, one open at a time. */}
      <PopoverDismiss />
```

In `apps/web/app/guide/layout.tsx`, add after line 11 (`import { serverStripLines } …`):

```tsx
import { POPOVER_GROUP } from "@/lib/popover";
```

and replace lines 46-48:

```tsx
        <details className="group relative">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center border border-rule-3 px-3 font-display text-xs uppercase tracking-[0.06em] text-ink group-open:border-ink [&::-webkit-details-marker]:hidden">Contents</summary>
          <div className="absolute right-0 top-[calc(100%+8px)] z-[1300] max-h-[75dvh] w-[min(86vw,320px)] overflow-y-auto border-2 border-rule-2 bg-frame pb-4 pt-3 shadow-[0_16px_40px_rgba(0,0,0,.6)]">
```

with:

```tsx
        <details name={POPOVER_GROUP} className="group">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center border border-rule-3 px-3 font-display text-xs uppercase tracking-[0.06em] text-ink group-open:border-ink [&::-webkit-details-marker]:hidden">Contents</summary>
          {/* ⚠️ Fixed to the viewport, not hung off the button: signed in, Contents sits left of the bell and Menu, and a right-anchored panel ran ~98px off a 375px screen (H1). */}
          <div className="fixed inset-x-3 top-[calc(var(--spacing-bar)+8px)] z-[1300] max-h-[calc(100dvh-var(--spacing-bar)-16px)] overflow-y-auto border-2 border-rule-2 bg-frame pb-4 pt-3 shadow-[0_16px_40px_rgba(0,0,0,.6)]">
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/popover.test.ts test/notifications-bell.test.ts test/menu.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/popover.ts apps/web/app/components/popover-dismiss.tsx apps/web/app/components/notifications-bell.tsx "apps/web/app/(site)/menu-list.tsx" "apps/web/app/(site)/site-bar.tsx" apps/web/app/guide/layout.tsx apps/web/test/popover.test.ts
git commit -m "fix(web): keep the bell and Contents panels on a phone screen, one popover at a time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The segmented nav wraps instead of overflowing (H2)

**Files:**
- Modify: `apps/web/app/components/ui.tsx:163-175`
- Test: `apps/web/test/seg-nav.test.ts`

**Interfaces:**
- Consumes: `SegNav({ items, label, className })`, with its signature unchanged; `ScopePicker` from `app/components/stat-boards.tsx`.
- Produces: the same `SegNav` API, now with wrapping markup.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/seg-nav.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopePicker } from "../app/components/stat-boards";

/**
 * H2: ScopePicker adds one cell per season. From Season 3 the single row is
 * wider than a phone (All-time + S1–S3 ≈ 384px against ~335px), and it shows
 * on /players, every player page and every full board.
 */
describe("SegNav with five seasons", () => {
  // Newest first, as the roster returns `seasons`.
  const html = renderToStaticMarkup(createElement(ScopePicker, { seasons: [5, 4, 3, 2, 1], basePath: "/players", current: { kind: "season", number: 5 } }));

  it("renders All-time and every season", () => {
    expect([...html.matchAll(/<a /gu)]).toHaveLength(6);
  });

  it("⚠️ wraps onto a second row rather than running off a phone or scrolling the current season out of view", () => {
    expect(html).toContain("flex-wrap");
    expect(html).not.toMatch(/overflow-x-(auto|scroll)/u);
  });

  it("⚠️ no cell is flex-1 — a zero basis never wraps, so the row just overflows", () => {
    expect(html).not.toMatch(/\bflex-1\b/u);
    expect(html).toMatch(/\bflex-auto\b/u);
  });

  it("marks Season 5 current", () => {
    expect(html).toMatch(/href="\/players\?season=5"[^>]*aria-current="page"/u);
  });

  it("draws the focus ring inside the clipped frame, where it can be seen", () => {
    expect(html).toContain("focus-visible:outline-offset-[-3px]");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/seg-nav.test.ts`
Expected: FAIL at "wraps…" (no `flex-wrap`) and at "no cell is flex-1".

- [ ] **Step 3: Implement**

In `apps/web/app/components/ui.tsx`, replace lines 163-175 (the whole `SegNav`):

```tsx
/**
 * The bordered segmented nav: scoreboard/alphas/seasons, all-time/season N.
 *
 * ⚠️ It WRAPS, never scrolls or overflows. ScopePicker adds one cell per
 * season, and from Season 3 one row is wider than a phone (H2, 2026-09-24).
 * A wrapped second row keeps every season, the current one included, on
 * screen with no JavaScript. Cells are `flex-auto` (basis = their own width),
 * never `flex-1`: a zero basis fits any number of cells on one line and so
 * never wraps. The hairlines are each cell's own top and left edges, pulled
 * 1px outside the frame and clipped, so a wrapped row gets them too.
 */
export function SegNav({ items, label, className = "" }: { items: { label: string; href: string; current?: boolean }[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={`max-w-full overflow-hidden border-2 border-rule-3 font-display text-xs uppercase tracking-[0.04em] ${className}`}>
      <div className="-ml-px -mt-px flex flex-wrap">
        {items.map((it) => (
          <a key={it.href} href={it.href} aria-current={it.current ? "page" : undefined}
            className={`flex min-h-[44px] flex-auto items-center justify-center whitespace-nowrap border-l border-t border-rule-2 px-3 text-center focus-visible:outline-offset-[-3px] lg:px-[18px] ${it.current ? "bg-gold text-ground" : "text-ink hover:bg-surface"}`}>
            {it.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/seg-nav.test.ts test/scope-picker.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/ui.tsx apps/web/test/seg-nav.test.ts
git commit -m "fix(web): wrap the season picker instead of running it off a phone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Small WebP flag thumbnails for every list, lazily loaded (H5, part 1)

**Files:**
- Modify: `apps/web/src/flag-images.ts:89-99` (append after `flagImagePath`)
- Create: `apps/web/scripts/build-flag-thumbs.ts`
- Create (generated, committed): `apps/web/public/flags/thumb/<texture>.webp` × 33
- Modify: `apps/web/app/components/stat-boards.tsx:2,29`
- Modify: `apps/web/app/(site)/page.tsx:4,83,117-118`
- Modify: `apps/web/app/(site)/clans/page.tsx:4,35,55-56,69`
- Modify: `apps/web/app/(site)/scoreboard/page.tsx:3,49,78`
- Modify: `apps/web/app/(site)/seasons/page.tsx:3,30,55`
- Modify: `apps/web/app/(site)/alphas/page.tsx:3,32,53`
- Test: `apps/web/test/flag-thumbs.test.ts`

**Interfaces:**
- Produces: `FLAG_THUMB_EDGE = 96`, and `flagThumbPath(texture: string): string` returning `flags/thumb/${texture}.webp`, relative to `public/`.
- Consumes: `CLAIMABLE_FLAGS` (`@factions/domain`), `pathIsPublic` (`lib/auth/gate.ts`), and `flagImagePath`. The PNGs stay exactly as they are, because the bot builds `${base}/flags/${texture}.png` itself.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/flag-thumbs.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { FLAG_THUMB_EDGE, flagThumbPath } from "../src/flag-images";
import { pathIsPublic } from "../lib/auth/gate";

const WEB = join(import.meta.dirname, "..");
const THUMBS = join(WEB, "public", "flags", "thumb");

/**
 * H5: every list drew the 256×128 PNG (~50KB, 1.7MB for the pool) at 24–48px.
 * The thumbnails are generated by scripts/build-flag-thumbs.ts from the
 * committed PNGs and committed. ⚠️ A texture added to CLAIMABLE_FLAGS without
 * re-running it is a broken image in every list, and nothing else notices —
 * the same two-statements-of-one-fact shape as flag-assets.test.ts.
 */
describe("flag thumbnails match CLAIMABLE_FLAGS", () => {
  const files = existsSync(THUMBS) ? readdirSync(THUMBS).filter((f) => f.endsWith(".webp")) : [];

  it("⚠️ every claimable flag has a thumbnail", () => {
    expect(CLAIMABLE_FLAGS.filter((t) => !files.includes(`${t}.webp`))).toEqual([]);
  });

  it("every thumbnail belongs to a claimable flag", () => {
    expect(files.filter((f) => !CLAIMABLE_FLAGS.includes(f.replace(/\.webp$/u, "")))).toEqual([]);
  });

  it("is FLAG_THUMB_EDGE on its long edge, landscape, and small", async () => {
    for (const f of files) {
      const { width = 0, height = 0, format } = await sharp(join(THUMBS, f)).metadata();
      expect(format, f).toBe("webp");
      expect(Math.max(width, height), `${f} long edge`).toBe(FLAG_THUMB_EDGE);
      expect(width, `${f} landscape`).toBeGreaterThan(height);
      expect(statSync(join(THUMBS, f)).size, `${f} bytes`).toBeLessThan(8_000);
    }
  });

  it("⚠️ is served to an anonymous visitor — public/ files are gated unless listed", () => {
    expect(flagThumbPath("Flag_Wolf")).toBe("flags/thumb/Flag_Wolf.webp");
    expect(pathIsPublic(`/${flagThumbPath("Flag_Wolf")}`)).toBe(true);
  });
});

/**
 * Only the heroes draw the full PNG (a 256–416px flag); every list draws the
 * thumbnail, lazily. The claim page is the FORMS plan's and keeps its PNG.
 */
describe("which pages use which flag", () => {
  const FULL_SIZE = new Set([
    "app/(site)/clans/[tag]/page.tsx",
    "app/(site)/players/[gamertag]/page.tsx",
    "app/components/own-clan-hero.tsx",
    "app/(site)/claim/[ceremony]/page.tsx",
  ]);
  const sources = (readdirSync(join(WEB, "app"), { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `app/${f.split("\\").join("/")}`)
    .map((rel) => [rel, readFileSync(join(WEB, rel), "utf8")] as const);

  it("no list draws the full-size PNG", () => {
    const offenders = sources.filter(([rel, text]) => !FULL_SIZE.has(rel) && text.includes("flagImagePath(")).map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("⚠️ every thumbnail <img> is loading=\"lazy\"", () => {
    const eager = sources.flatMap(([rel, text]) =>
      [...text.matchAll(/<img\b[^>]*flagThumbPath\([^>]*>/gu)].filter((m) => !m[0].includes('loading="lazy"')).map(() => rel));
    expect(eager).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/flag-thumbs.test.ts`
Expected: FAIL. `FLAG_THUMB_EDGE` / `flagThumbPath` are not exported, and there is no `public/flags/thumb/`.

- [ ] **Step 3: Implement**

Append to `apps/web/src/flag-images.ts`:

```ts

/**
 * The long edge of a list thumbnail, in px. Lists draw a flag in a 24–48px
 * box; a 2:1 flag there is at most 48 CSS px wide, so 96 covers a 2x screen.
 * Read by scripts/build-flag-thumbs.ts AND by test/flag-thumbs.test.ts — one
 * statement, so the script and its test cannot disagree.
 */
export const FLAG_THUMB_EDGE = 96;

/**
 * A list's flag, relative to `public/`: a small WebP beside the PNG.
 *
 * ⚠️ Under `flags/` on purpose: `/flags/` is in lib/auth/gate.ts's
 * PUBLIC_PREFIXES, and anything in public/ outside those lists 303s an
 * anonymous visitor to /login — every public list would draw a broken image.
 */
export function flagThumbPath(texture: string): string {
  return `flags/thumb/${texture}.webp`;
}
```

Create `apps/web/scripts/build-flag-thumbs.ts`:

```ts
/**
 * Derive the list thumbnails (public/flags/thumb/*.webp) from the 33
 * committed PNGs in public/flags/.
 *
 * ⚠️ Run BY HAND and commit the output, like fetch-flags.ts and
 * fetch-item-images.ts. It reads only files already in this repository, so it
 * needs no network, but committing the output means a deploy never depends
 * on sharp's native binary. Re-run it whenever a PNG in public/flags changes;
 * test/flag-thumbs.test.ts fails for a flag that has none.
 *
 *   pnpm --filter @factions/web exec tsx scripts/build-flag-thumbs.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { FLAG_THUMB_EDGE, flagImagePath, flagThumbPath } from "../src/flag-images.js";

const PUBLIC = join(import.meta.dirname, "..", "public");

async function main(): Promise<void> {
  let written = 0;
  for (const texture of CLAIMABLE_FLAGS) {
    const out = await sharp(join(PUBLIC, flagImagePath(texture)))
      .resize({ width: FLAG_THUMB_EDGE, height: FLAG_THUMB_EDGE, fit: "inside" })
      .webp({ quality: 85, effort: 6 })
      .toBuffer();
    const dest = join(PUBLIC, flagThumbPath(texture));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${texture.padEnd(20)} -> ${out.length} bytes`);
  }
  console.log(`\nwrote ${written} thumbnail(s) to public/flags/thumb/`);
  if (written !== CLAIMABLE_FLAGS.length) throw new Error(`expected ${CLAIMABLE_FLAGS.length}, wrote ${written}`);
}

await main();
```

Generate the thumbnails:

Run: `pnpm --filter @factions/web exec tsx scripts/build-flag-thumbs.ts`
Expected: 33 lines, each well under 8,000 bytes, then `wrote 33 thumbnail(s)`.

Swap every list image to the thumbnail. In each of `apps/web/app/components/stat-boards.tsx`, `apps/web/app/(site)/page.tsx`, `apps/web/app/(site)/clans/page.tsx`, `apps/web/app/(site)/scoreboard/page.tsx`, `apps/web/app/(site)/seasons/page.tsx` and `apps/web/app/(site)/alphas/page.tsx`, replace the import

```tsx
import { flagImagePath } from "@/src/flag-images";
```

with

```tsx
import { flagThumbPath } from "@/src/flag-images";
```

and make these exact `<img>` replacements. Each one swaps `flagImagePath` → `flagThumbPath` and adds `loading="lazy"` right after `alt`:

`stat-boards.tsx:29`
```tsx
  return <img src={`/${flagThumbPath(clan.texture)}`} alt={`[${clan.tag}]`} loading="lazy" title={clan.tag} width={24} height={24} className="h-6 w-6 flex-none object-contain" />;
```

`(site)/page.tsx:83`
```tsx
                  <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={32} height={32} className={`h-7 w-7 object-contain lg:h-8 lg:w-8 ${r.status === "dormant" ? "opacity-60" : ""}`} />
```

`(site)/page.tsx:117-118`
```tsx
              {flags.free.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={f} loading="lazy" title={f} width={36} height={36} className="h-9 w-9 object-contain" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={`${f} (taken)`} loading="lazy" title={`${f} — taken`} width={36} height={36} className="h-9 w-9 object-contain opacity-35" />)}
```

`clans/page.tsx:35`
```tsx
                      <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={40} height={40} className="h-9 w-9 object-contain lg:h-10 lg:w-10" />
```

`clans/page.tsx:55-56`
```tsx
              {flags.free.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={f} loading="lazy" title={f} width={40} height={40} className="h-9 w-9 object-contain lg:h-10 lg:w-10" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={`${f} (taken)`} loading="lazy" title={`${f} — taken`} width={40} height={40} className="h-9 w-9 object-contain opacity-30 lg:h-10 lg:w-10" />)}
```

`clans/page.tsx:69`
```tsx
                    <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={32} height={32} className={`h-7 w-7 object-contain lg:h-8 lg:w-8 ${dormant ? "opacity-60" : ""}`} />
```

`scoreboard/page.tsx:49`
```tsx
                            <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={36} height={36} className={`h-9 w-9 object-contain ${dormant ? "opacity-60" : ""}`} />
```

`scoreboard/page.tsx:78`
```tsx
                        <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={28} height={28} className={`h-7 w-7 flex-none object-contain ${dormant ? "opacity-60" : ""}`} />
```

`seasons/page.tsx:30`
```tsx
              {s.champion && <img src={`/${flagThumbPath(s.champion.texture)}`} alt="" loading="lazy" width={48} height={48} className="h-10 w-10 object-contain lg:h-12 lg:w-12" />}
```

`seasons/page.tsx:55`
```tsx
                          <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={28} height={28} className="h-7 w-7 object-contain" />
```

`alphas/page.tsx:32`
```tsx
                    <img src={`/${flagThumbPath(e.texture)}`} alt="" loading="lazy" width={36} height={36} className="h-7 w-7 object-contain lg:h-9 lg:w-9" />
```

`alphas/page.tsx:53`
```tsx
                  {s.champion && <img src={`/${flagThumbPath(s.champion.texture)}`} alt="" loading="lazy" width={48} height={48} className="h-10 w-10 object-contain lg:h-12 lg:w-12" />}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/flag-thumbs.test.ts test/flag-assets.test.ts test/flag-images.test.ts test/auth-gate.test.ts && npx tsc --noEmit`
Expected: PASS. `flag-assets.test.ts` still counts exactly 33 `.png` in `public/flags`, because it filters on `.png`, so the `thumb/` directory is not counted.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/flag-images.ts apps/web/scripts/build-flag-thumbs.ts apps/web/public/flags/thumb apps/web/app/components/stat-boards.tsx "apps/web/app/(site)/page.tsx" "apps/web/app/(site)/clans/page.tsx" "apps/web/app/(site)/scoreboard/page.tsx" "apps/web/app/(site)/seasons/page.tsx" "apps/web/app/(site)/alphas/page.tsx" apps/web/test/flag-thumbs.test.ts
git commit -m "fix(web): draw list flags from 96px WebP thumbnails, lazily

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The landing flag pool is never rendered on a phone (H5, part 2)

**Files:**
- Create: `apps/web/app/components/wide-only.tsx`
- Modify: `apps/web/app/(site)/page.tsx:8-10,115-120`
- Test: `apps/web/test/wide-only.test.ts`

**Interfaces:**
- Produces: `WideOnly({ children }: { children: React.ReactNode }): React.ReactNode`, a client component. It renders `null` on the server and at widths below 1024px.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/wide-only.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WideOnly } from "../app/components/wide-only";

const WEB = join(import.meta.dirname, "..");

/**
 * H5: the landing page's Flag pool was `hidden lg:block`, and a browser still
 * fetches every <img> inside a CSS-hidden panel — a phone downloaded the whole
 * pool and never showed it. Not rendering it is the only fix a phone obeys.
 */
describe("WideOnly", () => {
  it("⚠️ renders nothing on the server, so a phone never receives the <img> tags", () => {
    const html = renderToStaticMarkup(createElement(WideOnly, { children: createElement("img", { src: "/flags/thumb/Flag_Wolf.webp", alt: "" }) }));
    expect(html).toBe("");
  });

  it("⚠️ asks for Tailwind's lg exactly", () => {
    expect(readFileSync(join(WEB, "app", "components", "wide-only.tsx"), "utf8")).toContain('"(min-width: 1024px)"');
  });

  it("wraps the landing page's flag pool, which no longer needs a CSS hide", () => {
    const page = readFileSync(join(WEB, "app", "(site)", "page.tsx"), "utf8");
    expect(page).toMatch(/<WideOnly>\s*<Panel num="03" title="Flag pool"/u);
    expect(page).not.toMatch(/title="Flag pool"[^>]*hidden lg:block/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/wide-only.test.ts`
Expected: FAIL. `../app/components/wide-only` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/web/app/components/wide-only.tsx`:

```tsx
"use client";
import { useSyncExternalStore } from "react";

/** ⚠️ Tailwind's `lg` (64rem = 1024px). Two statements of one breakpoint; test/wide-only.test.ts pins this one. */
const QUERY = "(min-width: 1024px)";

const subscribe = (onChange: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
};

/**
 * Children that exist only on a desktop-width screen. Not `hidden lg:block`:
 * a browser fetches every <img> in a CSS-hidden subtree, so a phone paid for
 * pictures it never showed (H5). The server snapshot is `false`, so the server
 * renders nothing and hydration agrees; a wide screen mounts the children one
 * render later. Use it only for content below the fold that is also reachable
 * elsewhere (the pool is on /clans in full).
 */
export function WideOnly({ children }: { children: React.ReactNode }) {
  const wide = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  return wide ? <>{children}</> : null;
}
```

In `apps/web/app/(site)/page.tsx`, add after line 9 (`import { HeroMap } …`):

```tsx
import { WideOnly } from "@/app/components/wide-only";
```

and replace the Flag pool panel (lines 115-120; Task 3 already changed the `<img>` lines inside it):

```tsx
          <Panel num="03" title="Flag pool" aside={<span className={kicker}>{flags.free.length} free</span>} className="hidden lg:block">
            <div className="flex flex-wrap gap-2.5 p-5">
              {flags.free.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={f} loading="lazy" title={f} width={36} height={36} className="h-9 w-9 object-contain" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={`${f} (taken)`} loading="lazy" title={`${f} — taken`} width={36} height={36} className="h-9 w-9 object-contain opacity-35" />)}
            </div>
          </Panel>
```

with:

```tsx
          {/* ⚠️ Not rendered on a phone at all (WideOnly), not CSS-hidden: a hidden panel's images download anyway (H5). */}
          <WideOnly>
          <Panel num="03" title="Flag pool" aside={<span className={kicker}>{flags.free.length} free</span>}>
            <div className="flex flex-wrap gap-2.5 p-5">
              {flags.free.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={f} loading="lazy" title={f} width={36} height={36} className="h-9 w-9 object-contain" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={`${f} (taken)`} loading="lazy" title={`${f} — taken`} width={36} height={36} className="h-9 w-9 object-contain opacity-35" />)}
            </div>
          </Panel>
          </WideOnly>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/wide-only.test.ts test/flag-thumbs.test.ts test/menu.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/wide-only.tsx "apps/web/app/(site)/page.tsx" apps/web/test/wide-only.test.ts
git commit -m "fix(web): stop phones downloading the landing page's hidden flag pool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Contrast and tiny text (H3, H4, M7)

**Files:**
- Modify: `apps/web/app/guide/guide.css:39,46,49-51`
- Modify: `apps/web/app/(site)/alphas/page.tsx:52`
- Modify: `apps/web/app/(site)/seasons/page.tsx:29`
- Modify: `apps/web/app/components/timer-bar.tsx:15`
- Modify: `apps/web/app/components/notice-row.tsx:48,51`
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx:125`
- Update: `apps/web/test/__snapshots__/timer-bar-render.test.ts.snap` (regenerated)
- Test: `apps/web/test/text-floor.test.ts`

**Interfaces:** none. These are markup and CSS changes only.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/text-floor.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

/**
 * The shell and public pages this plan owns (2026-09-24 review). The FORMS
 * and MAP plans own the rest of app/, so this list is explicit rather than a
 * directory scan that would fail on their files.
 */
const OWNED = [
  "app/components/ui.tsx", "app/components/timer-bar.tsx", "app/components/notice-row.tsx",
  "app/components/notifications-bell.tsx", "app/components/server-strip.tsx", "app/components/install-strip.tsx",
  "app/components/stat-boards.tsx", "app/components/player-feed.tsx", "app/components/achievement-wall.tsx",
  "app/components/owner.tsx", "app/components/hero-map.tsx", "app/(site)/site-bar.tsx", "app/(site)/menu-list.tsx",
  "app/(site)/page.tsx", "app/(site)/clans/page.tsx", "app/(site)/clans/[tag]/page.tsx", "app/(site)/scoreboard/page.tsx",
  "app/(site)/alphas/page.tsx", "app/(site)/seasons/page.tsx", "app/(site)/war-log/page.tsx", "app/(site)/war-log/entry.tsx",
  "app/(site)/awards/page.tsx", "app/(site)/awards/[id]/award-flow.tsx", "app/(site)/players/page.tsx",
  "app/(site)/players/[gamertag]/page.tsx", "app/guide/layout.tsx", "app/guide/chapter.tsx", "app/guide/search.tsx",
  "app/not-found.tsx",
];

describe("the 11px floor (M7)", () => {
  it.each(OWNED)("%s sets no meaningful text below 11px", (rel) => {
    expect(read(rel)).not.toMatch(/\btext-\[(?:[0-9]|10)px\]/u);
  });

  it("guide.css sets no font-size below 11px", () => {
    const sizes = [...read("app/guide/guide.css").matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gu)].map((m) => Number(m[1]));
    expect(sizes.filter((n) => n < 11)).toEqual([]);
  });
});

describe("panel edges are not text colours (H4)", () => {
  it.each(OWNED)("%s never uses rule or rule-2 as a text colour", (rel) => {
    // rule is 1.2:1 and rule-2 1.34:1 on the frame. rule-3 (3.2:1) stays allowed for aria-hidden glyphs.
    expect(read(rel)).not.toMatch(/\btext-rule(?:-2)?(?![-\w])/u);
  });

  it("the season numeral on /alphas also exists as real text", () => {
    expect(read("app/(site)/alphas/page.tsx")).toMatch(/<span className="sr-only">Season \{s\.number\}<\/span>/u);
  });
});

describe("rust is never text (H3)", () => {
  it("⚠️ guide.css colours no text with --color-rust — that is 2.6:1; rust-2 is rust as text", () => {
    expect(read("app/guide/guide.css")).not.toMatch(/(?<!-)color:\s*var\(--color-rust\)/u);
    expect(read("app/guide/guide.css")).toMatch(/\.human::before\s*\{[^}]*color:\s*var\(--color-rust-2\)/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/text-floor.test.ts`
Expected: FAIL for timer-bar.tsx, notice-row.tsx and award-flow.tsx (10px/9px), for guide.css (10px ×3, rust text), and for alphas/seasons (`text-rule-2`).

- [ ] **Step 3: Implement**

`apps/web/app/guide/guide.css`, in lines 39, 46 and 51, change `font-size: 10px` to `font-size: 11px`. Also replace lines 49-51:

```css
/* Enforced by people — rust means an obligation, not a decoration. */
.prose-guide .human { margin: 20px 0; padding: 18px 20px; border: 2px solid var(--color-rust); background: var(--color-frame); max-width: 66ch; font-size: 15px; line-height: 1.6; }
.prose-guide .human::before { content: "Enforced by people"; display: block; margin-bottom: 8px; font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: .18em; color: var(--color-rust); }
```

with:

```css
/* Enforced by people — rust means an obligation, not a decoration.
   ⚠️ The EDGE is --color-rust; the LABEL is --color-rust-2. --color-rust as text is 2.6:1 on the frame (H3); rust-2 is the same hue at 5:1. */
.prose-guide .human { margin: 20px 0; padding: 18px 20px; border: 2px solid var(--color-rust); background: var(--color-frame); max-width: 66ch; font-size: 15px; line-height: 1.6; }
.prose-guide .human::before { content: "Enforced by people"; display: block; margin-bottom: 8px; font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .18em; color: var(--color-rust-2); }
```

`apps/web/app/(site)/alphas/page.tsx:52`, replace:

```tsx
                  <span className="font-display text-[40px] leading-none text-rule-2 lg:text-[48px]">S{s.number}</span>
```

with:

```tsx
                  {/* ⚠️ The only place /alphas names the season, so it is real text for a screen reader and dim, not rule-2 (1.34:1), for everyone else (H4). */}
                  <span aria-hidden="true" className="font-display text-[40px] leading-none text-dim lg:text-[48px]">S{s.number}</span>
                  <span className="sr-only">Season {s.number}</span>
```

`apps/web/app/(site)/seasons/page.tsx:29`, replace:

```tsx
              <span className="font-display text-[40px] leading-none text-rule-2 lg:text-[48px]">S{s.number}</span>
```

with:

```tsx
              {/* Decoration: the panel's own title already says "Season N". Dim, not rule-2 (1.34:1), because it is still read by eye (H4). */}
              <span aria-hidden="true" className="font-display text-[40px] leading-none text-dim lg:text-[48px]">S{s.number}</span>
```

`apps/web/app/components/timer-bar.tsx:15`, replace:

```tsx
const KICKER = "font-mono text-[10px] font-bold uppercase tracking-[0.16em] lg:text-[11px] lg:tracking-[0.18em]";
```

with:

```tsx
/** ⚠️ 11px at every width: the kicker carries real words ("Raid", "Restart", a skip reason), and 10px failed the floor on the phone (M7). Tracking tightens on a phone instead, so the two columns still fit. */
const KICKER = "font-mono text-[11px] font-bold uppercase tracking-[0.12em] lg:tracking-[0.18em]";
```

`apps/web/app/components/notice-row.tsx`, change line 48's `text-[10px]` and line 51's `text-[10px]` to `text-[11px]`, which makes them:

```tsx
          <span className={`font-mono text-[11px] font-bold uppercase tracking-[0.16em] ${kicker}`}>
```

```tsx
          <time dateTime={row.occurredAt.toISOString()} className="font-mono text-[11px] tracking-[0.1em] text-dim">
```

`apps/web/app/(site)/awards/[id]/award-flow.tsx:125`, replace:

```tsx
                  <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{s.label}</span>
```

with:

```tsx
                  <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{s.label}</span>
```

Regenerate the timer-bar snapshots, and read the diff before accepting it:

Run: `cd apps/web && npx vitest run test/timer-bar-render.test.ts -u && git diff --stat test/__snapshots__/timer-bar-render.test.ts.snap && git diff test/__snapshots__/timer-bar-render.test.ts.snap | grep '^[-+]' | grep -v 'text-\[1[01]px\]\|tracking-\[0\.1[26]em\]' | grep -v '^[-+][-+]'`
Expected: the last command prints nothing, meaning every changed snapshot line differs only in the kicker size and tracking.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/text-floor.test.ts test/timer-bar-render.test.ts test/notice-row.test.ts test/award-render.test.tsx test/guide.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/guide/guide.css "apps/web/app/(site)/alphas/page.tsx" "apps/web/app/(site)/seasons/page.tsx" apps/web/app/components/timer-bar.tsx apps/web/app/components/notice-row.tsx "apps/web/app/(site)/awards/[id]/award-flow.tsx" apps/web/test/__snapshots__/timer-bar-render.test.ts.snap apps/web/test/text-floor.test.ts
git commit -m "fix(web): lift sub-11px labels and unreadable season numerals, rust-2 for the guide's rust label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The server-name marquee stops and can be paused without a mouse (M1)

**Files:**
- Modify: `apps/web/app/globals.css:70-72`
- Modify: `apps/web/app/components/server-strip.tsx:1-31`
- Test: `apps/web/test/server-strip.test.ts` (append)

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/server-strip.test.ts`:

```ts
/**
 * M1, WCAG 2.2.2: moving text lasting over five seconds needs a way to pause
 * it. `:hover` alone is no way at all on a phone or a keyboard.
 */
describe("the marquee can be stopped", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "server-strip.tsx"), "utf8");

  it("⚠️ runs two passes and stops, never infinite", () => {
    expect(css).toMatch(/\.cw-marquee\s*\{\s*animation:\s*cw-marquee\s+\d+s\s+linear\s+2;/u);
    expect(css).not.toMatch(/cw-marquee[^;]*infinite/u);
  });

  it("⚠️ pauses on focus as well as hover, and the strip is focusable by Tab or tap", () => {
    expect(css).toMatch(/\.cw-marquee-host:focus \.cw-marquee/u);
    expect(css).toMatch(/\.cw-marquee-host:hover \.cw-marquee/u);
    expect(src).toContain("tabIndex={0}");
    expect(src).toContain("cw-marquee-host");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/server-strip.test.ts`
Expected: FAIL. The CSS still says `infinite`, and there is no `.cw-marquee-host`.

- [ ] **Step 3: Implement**

`apps/web/app/globals.css`, replace lines 70-72:

```css
/* The server-name marquee under the top bar (components/server-strip.tsx): the track holds the line twice and slides by one copy, so the loop is seamless. Pauses on hover so the name can be read or selected. */
.cw-marquee { animation: cw-marquee 20s linear infinite; }
.cw-marquee-clip:hover .cw-marquee { animation-play-state: paused; }
```

with:

```css
/*
 * The server-name marquee under the top bar (components/server-strip.tsx): the track holds the line twice and slides by one copy, so a pass is seamless.
 * ⚠️ WCAG 2.2.2 (M1): moving text lasting over five seconds needs a way to stop it, and :hover is none on a phone or a keyboard. So it runs TWO passes and stops — the track ends one copy along, which looks exactly like the start — and it pauses while the strip has focus: the strip is focusable, so a Tab or a tap is the pause.
 */
.cw-marquee { animation: cw-marquee 20s linear 2; }
.cw-marquee-host:hover .cw-marquee, .cw-marquee-host:focus .cw-marquee { animation-play-state: paused; }
```

`apps/web/app/components/server-strip.tsx`, replace the whole component (lines 3-31) with:

```tsx
/**
 * The server-name marquee directly under the top bar, in the bar's own
 * frame: "SERVER NAME: <name>" in display caps, gold on the name, scrolling
 * right to left. The line is rendered twice inside one track so a pass is
 * seamless (the track slides by half its width, which is one copy);
 * `aria-hidden` on the second keeps a screen reader from hearing it twice.
 * Under prefers-reduced-motion the track sits still (globals.css).
 *
 * ⚠️ `tabIndex={0}` is the pause button (M1): focus pauses the scroll
 * (globals.css), and a tap on a phone focuses it. It stops by itself after
 * two passes either way.
 *
 * A server component: nothing to hydrate. Nothing to show renders nothing —
 * a fresh install with no swept server has no strip, not an empty one.
 */
export function ServerStrip({ lines }: { lines: ServerStripLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div role="region" aria-label="Server name" tabIndex={0} className="cw-marquee-host border-b-2 border-rule-2 bg-frame focus-visible:outline-offset-[-2px]">
      {lines.map((line) => (
        <div key={line} className="flex h-9 items-center overflow-hidden">
          <div className="cw-marquee flex w-max" style={{ animationDuration: `${marqueeSeconds(line)}s` }}>
            {[false, true].map((dup) => (
              <span key={String(dup)} aria-hidden={dup || undefined} className="whitespace-nowrap pr-24 font-display text-sm uppercase tracking-[0.04em] text-muted">
                {splitLine(line).label} <span className="text-gold">{splitLine(line).name}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/server-strip.test.ts && npx tsc --noEmit`
Expected: PASS. The existing "no button, not a client component" and reduced-motion assertions still hold.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/globals.css apps/web/app/components/server-strip.tsx apps/web/test/server-strip.test.ts
git commit -m "fix(web): stop the server-name marquee after two passes, pause it on focus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Guide stays in the bar at 1024–1279px (M2)

**Files:**
- Modify: `apps/web/lib/menu.ts:20`
- Modify: `apps/web/app/(site)/menu-list.tsx:24,33,43`
- Modify: `apps/web/app/(site)/site-bar.tsx:29-34`
- Test: `apps/web/test/menu.test.ts` (append)

**Interfaces:** `MenuItem.quiet` keeps its type and now only mutes the colour.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/menu.test.ts`, which already imports `readdirSync`, `existsSync` and `join` from node. Add `readFileSync` to its `node:fs` import:

```ts
/**
 * M2: at 1024–1279px the quiet Guide cell was `!hidden xl:!flex`, the drawer
 * is lg:hidden, and the footer is on two pages — so the guide was reachable
 * from nowhere. The room now comes from the wordmark and the cell padding.
 */
describe("the bar between lg and xl", () => {
  const site = (f: string) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", f), "utf8");

  it("⚠️ never hides the quiet Guide cell", () => {
    expect(site("menu-list.tsx")).not.toMatch(/!hidden\s+xl:!flex/u);
  });

  it("buys the room by dropping the wordmark and the crumb to xl, never the guide", () => {
    const bar = site("site-bar.tsx");
    expect(bar).toMatch(/<span className="lg:max-xl:sr-only">Clan Wars<\/span>/u);
    expect(bar).toMatch(/hidden text-muted xl:inline">\/ \{crumb\}/u);
  });

  it("the Guide is still in the bar", () => {
    expect(barFor(true).flat().some((m) => m.href === "/guide")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/menu.test.ts`
Expected: FAIL. `!hidden xl:!flex` is still present, and the wordmark has no span.

- [ ] **Step 3: Implement**

`apps/web/lib/menu.ts:20`, replace:

```ts
  /** The bar draws this one quieter (the guide is a different kind of place) and, below xl, not at all: signed in, nine cells, the bell (site-bar.tsx, since the notifications feature), and Sign out already fill 1024px. It stays in the drawer and the footer. */
```

with:

```ts
  /**
   * The bar draws this one quieter (the guide is a different kind of place).
   * ⚠️ Quieter, never hidden: at 1024–1279px the drawer is gone (lg:hidden)
   * and the footer is on two pages, so a hidden Guide cell left the guide
   * unreachable (M2, 2026-09-24). The bar makes room below xl by dropping the
   * wordmark to sr-only and tightening the cells (site-bar.tsx, menu-list.tsx).
   */
```

`apps/web/app/(site)/menu-list.tsx`:
- In line 24, change `border-l border-rule-2 px-4 font-display` to `border-l border-rule-2 px-3 font-display xl:px-4` so the line reads:

```tsx
  const cell = "flex h-full items-center border-l border-rule-2 px-3 font-display text-xs uppercase tracking-[0.06em] xl:px-4";
```

- Replace line 33:

```tsx
                className={`${cell} gap-2 ${on ? "text-gold shadow-[inset_0_-2px_0_var(--color-gold)]" : m.quiet ? "text-muted hover:text-ink" : "text-ink hover:text-gold"} ${m.quiet ? "!hidden xl:!flex" : ""}`}>
```

with:

```tsx
                className={`${cell} gap-2 ${on ? "text-gold shadow-[inset_0_-2px_0_var(--color-gold)]" : m.quiet ? "text-muted hover:text-ink" : "text-ink hover:text-gold"}`}>
```

- In line 43, change `pl-5` to `pl-4 xl:pl-5`:

```tsx
          <button type="submit" className="flex h-full items-center pl-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink xl:pl-5">Sign out</button>
```

`apps/web/app/(site)/site-bar.tsx`, replace lines 29-34:

```tsx
    <header className="sticky top-0 z-[1300] flex h-bar items-center justify-between border-b-2 border-rule-2 bg-frame pl-4 pr-4 lg:pl-8 lg:pr-8">
      <a className="flex items-center gap-2.5 font-display text-sm uppercase tracking-[0.02em] text-ink" href="/">
        <img src="/mark.png" alt="" width={28} height={28} />
        Clan Wars
        {crumb && <span className="ml-1.5 hidden text-muted lg:inline">/ {crumb}</span>}
      </a>
```

with:

```tsx
    <header className="sticky top-0 z-[1300] flex h-bar items-center justify-between border-b-2 border-rule-2 bg-frame px-4 lg:px-5 xl:px-8">
      {/* ⚠️ Between lg and xl the wordmark and the crumb give up their width so every nav cell fits, the Guide included (M2). The mark stays; the name stays for a screen reader. */}
      <a className="flex items-center gap-2.5 font-display text-sm uppercase tracking-[0.02em] text-ink" href="/">
        <img src="/mark.png" alt="" width={28} height={28} />
        <span className="lg:max-xl:sr-only">Clan Wars</span>
        {crumb && <span className="ml-1.5 hidden text-muted xl:inline">/ {crumb}</span>}
      </a>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/menu.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/menu.ts "apps/web/app/(site)/menu-list.tsx" "apps/web/app/(site)/site-bar.tsx" apps/web/test/menu.test.ts
git commit -m "fix(web): keep the Guide in the top bar between 1024 and 1279px

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Tables name themselves and their headers (M3)

**Files:**
- Modify: `apps/web/app/(site)/scoreboard/page.tsx:29-40`
- Modify: `apps/web/app/(site)/seasons/page.tsx:38-47`
- Modify: `apps/web/app/guide/chapter.tsx:69-92`
- Modify: `apps/web/app/guide/guide.css:64`
- Test: `apps/web/test/table-semantics.test.ts`

**Interfaces:** `GroupRows` (private to chapter.tsx) now returns a `<tbody>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/table-semantics.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GUIDE_GROUPS } from "@factions/domain";
import ChapterPage from "../app/guide/chapter";
import { CHAPTERS } from "../lib/guide";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", ...p), "utf8");

describe("the scoreboard and seasons tables (M3)", () => {
  it.each([["(site)", "scoreboard", "page.tsx"], ["(site)", "seasons", "page.tsx"]])("%s/%s: every <th> has a scope, and the table has a caption", (...p) => {
    const src = read(...p);
    const ths = [...src.matchAll(/<th\b[^>]*>/gu)].map((m) => m[0]);
    expect(ths.length).toBeGreaterThan(0);
    expect(ths.filter((t) => !/scope="col"/u.test(t))).toEqual([]);
    expect(src).toMatch(/<caption className="sr-only">/u);
  });
});

describe("the guide's Every number table (M3)", () => {
  const html = renderToStaticMarkup(createElement(ChapterPage, { chapter: CHAPTERS.find((c) => c.slug === "numbers")! }));

  it("has a header row a screen reader can announce", () => {
    expect(html).toMatch(/<thead class="sr-only"><tr><th scope="col">Rule<\/th><th scope="col">Value<\/th><\/tr><\/thead>/u);
  });

  it("⚠️ each group is a real row-group header, not a td dressed as one", () => {
    expect([...html.matchAll(/<th scope="rowgroup" colSpan="2">/giu)]).toHaveLength(GUIDE_GROUPS.length);
    expect([...html.matchAll(/<tbody>/gu)]).toHaveLength(GUIDE_GROUPS.length);
    expect(html).not.toMatch(/<td colSpan="2">/iu);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/table-semantics.test.ts`
Expected: FAIL. There is no `scope`, no caption, no thead, and the group rows are `<td colSpan="2">`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/scoreboard/page.tsx`, replace lines 29-40:

```tsx
            <Panel className="hidden lg:block">
              <table className="w-full border-collapse text-[15px]">
                <thead>
                  <tr>
                    <th className={`${th} w-[72px]`}>Rank</th>
                    <th className={`${th} !px-0`}>Clan</th>
                    <th className={`${th} text-right`}>Points</th>
                    <th className={`${th} text-right`}>Raids</th>
                    <th className={`${th} text-right`}>Raided</th>
                    <th className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
```

with:

```tsx
            <Panel className="hidden lg:block">
              <table className="w-full border-collapse text-[15px]">
                {/* The panel has no title, so the caption is the table's only name (M3). */}
                <caption className="sr-only">Season {season.number} standings</caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${th} w-[72px]`}>Rank</th>
                    <th scope="col" className={`${th} !px-0`}>Clan</th>
                    <th scope="col" className={`${th} text-right`}>Points</th>
                    <th scope="col" className={`${th} text-right`}>Raids</th>
                    <th scope="col" className={`${th} text-right`}>Raided</th>
                    <th scope="col" className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
```

`apps/web/app/(site)/seasons/page.tsx`, replace lines 38-47:

```tsx
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${th} w-16`}>Rank</th>
                    <th className={`${th} !px-0`}>Clan</th>
                    <th className={`${th} text-right`}>Points</th>
                    <th className={`${th} text-right`}>Raids</th>
                    <th className={`${th} text-right`}>Raided</th>
                    <th className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
```

with:

```tsx
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <caption className="sr-only">Season {s.number} final standings</caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${th} w-16`}>Rank</th>
                    <th scope="col" className={`${th} !px-0`}>Clan</th>
                    <th scope="col" className={`${th} text-right`}>Points</th>
                    <th scope="col" className={`${th} text-right`}>Raids</th>
                    <th scope="col" className={`${th} text-right`}>Raided</th>
                    <th scope="col" className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
```

`apps/web/app/guide/chapter.tsx`, replace lines 69-92 (from `<div className="tablewrap">` to the end of `GroupRows`):

```tsx
      <div className="tablewrap">
        <table>
          <tbody>
            {GUIDE_GROUPS.map((g) => (
              <GroupRows key={g} group={g} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ group }: { group: string }) {
  const rows = GUIDE_NUMBERS.filter((r) => r.group === group);
  return (
    <>
      <tr className="group"><td colSpan={2}>{group}</td></tr>
      {rows.map((r) => (
        <tr key={r.key}><td>{r.label}</td><td className="v">{r.value}</td></tr>
      ))}
    </>
  );
}
```

with:

```tsx
      <div className="tablewrap">
        <table>
          {/* ⚠️ Visually the group rows are the headings; a screen reader needs the column names said once and each group as a real row-group header (M3). */}
          <thead className="sr-only"><tr><th scope="col">Rule</th><th scope="col">Value</th></tr></thead>
          {GUIDE_GROUPS.map((g) => (
            <GroupRows key={g} group={g} />
          ))}
        </table>
      </div>
    </div>
  );
}

/** One group: its own <tbody>, so `scope="rowgroup"` covers exactly its rows. */
function GroupRows({ group }: { group: string }) {
  const rows = GUIDE_NUMBERS.filter((r) => r.group === group);
  return (
    <tbody>
      <tr className="group"><th scope="rowgroup" colSpan={2}>{group}</th></tr>
      {rows.map((r) => (
        <tr key={r.key}><td>{r.label}</td><td className="v">{r.value}</td></tr>
      ))}
    </tbody>
  );
}
```

`apps/web/app/guide/guide.css:64`, replace:

```css
.prose-guide tr.group td { color: var(--color-gold); font-family: var(--font-display); text-transform: uppercase; font-size: .9em; letter-spacing: .04em; padding-top: 22px; border-bottom: 2px solid var(--color-rule-2); }
```

with:

```css
/* A group's header is a <th scope="rowgroup"> (chapter.tsx); this outranks `.prose-guide th`'s muted small caption. */
.prose-guide tr.group th { color: var(--color-gold); font-family: var(--font-display); text-transform: uppercase; font-size: .9em; letter-spacing: .04em; padding-top: 22px; border-bottom: 2px solid var(--color-rule-2); }
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/table-semantics.test.ts test/guide.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/scoreboard/page.tsx" "apps/web/app/(site)/seasons/page.tsx" apps/web/app/guide/chapter.tsx apps/web/app/guide/guide.css apps/web/test/table-semantics.test.ts
git commit -m "fix(web): give the standings and every-number tables captions, scopes and row groups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The war log's days are headings and its entries a list (M4)

**Files:**
- Modify: `apps/web/app/(site)/war-log/entry.tsx` (append `WarLogDays` and the helpers moved from the page)
- Modify: `apps/web/app/(site)/war-log/page.tsx:1-30,60-88`
- Test: `apps/web/test/war-log-days.test.ts`

**Interfaces:**
- Produces: `WarLogDays({ entries }: { entries: WarLogEntry[] })`, exported from `app/(site)/war-log/entry.tsx`.
- Moves: `dayOf`, `timeOf`, `byDay` and `Outcome` go from page.tsx to entry.tsx. They are unexported, because a page file may export only its route members.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/war-log-days.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WarLogEntry } from "@factions/roster";
import { WarLogDays } from "../app/(site)/war-log/entry";

const raid = (at: string): WarLogEntry => ({
  kind: "raid", at: new Date(at), raider: { tag: "AAA", name: "Alpha" },
  victim: { tag: "BBB", name: "Bravo", texture: "Flag_Wolf" }, gamertag: "Ron", points: 12, lowers: 1,
});

/** M4: day headings were styled <div>s and entries <div>s — no heading or list shortcuts through a long log. */
describe("the war log's day groups", () => {
  const html = renderToStaticMarkup(createElement(WarLogDays, {
    entries: [raid("2026-09-20T22:14:00Z"), raid("2026-09-20T09:00:00Z"), raid("2026-09-19T18:30:00Z")],
  }));

  it("⚠️ one <h2> per UTC day", () => {
    expect([...html.matchAll(/<h2\b/gu)]).toHaveLength(2);
  });

  it("⚠️ each day's entries are a list", () => {
    expect([...html.matchAll(/<ul\b/gu)]).toHaveLength(2);
    expect([...html.matchAll(/<li\b/gu)]).toHaveLength(3);
  });

  it("says the day heading is in UTC", () => {
    expect(html).toMatch(/<h2[^>]*>.*UTC.*<\/h2>/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/war-log-days.test.ts`
Expected: FAIL. `WarLogDays` is not exported.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/war-log/entry.tsx`, replace lines 1-2:

```tsx
import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";
```

with:

```tsx
import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";
import { kickerSm } from "@/app/components/ui";
```

and append to the end of the file:

```tsx

const dayOf = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const timeOf = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Entries grouped by UTC day, newest first — the roster already sorts them. */
function byDay(entries: WarLogEntry[]): [string, WarLogEntry[]][] {
  const out: [string, WarLogEntry[]][] = [];
  for (const e of entries) {
    const day = dayOf(e.at);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e); else out.push([day, [e]]);
  }
  return out;
}

function Outcome({ e }: { e: WarLogEntry }) {
  if (e.kind === "defense") return <span className={`${kickerSm} !text-olive`}>Defended</span>;
  if (!e.raider) return <span className="font-mono text-[11px] text-muted">—</span>;
  return <span className="font-display text-lg text-ink">{e.points} <span className="font-mono text-[11px] text-muted">pts</span></span>;
}

/**
 * /war-log's body: one heading per UTC day, that day's entries as a list.
 *
 * ⚠️ A real <h2> and a real <ul> (M4): a screen reader skims a 200-entry log
 * by its heading and list shortcuts, and the styled <div>s this replaced
 * offered neither. The page's h1 is the PageHead; the panel has no title of
 * its own, so the days are the h2s.
 */
export function WarLogDays({ entries }: { entries: WarLogEntry[] }) {
  return (
    <>
      {byDay(entries).map(([day, list]) => (
        <section key={day}>
          <h2 className={`m-0 flex justify-between border-b-2 border-rule-2 px-4 py-2 lg:px-6 lg:py-2.5 ${kickerSm} !text-dim`}><span>{day}</span><span>UTC</span></h2>
          <ul>
            {list.map((e, i) => (
              <li key={i} className="border-b border-rule-2 last:border-b-0">
                {/* Desktop: time | dot | sentence | outcome. */}
                <div className="hidden min-h-[64px] grid-cols-[120px_8px_1fr_auto] items-center gap-x-5 px-6 py-3 text-[15px] text-ink-2 lg:grid">
                  <span className="font-mono text-xs text-muted">{timeOf(e.at)}</span>
                  <span aria-hidden="true" className={`h-2 w-2 ${e.kind === "raid" ? "bg-gold" : "bg-olive"}`} />
                  <span><WarLogLine e={e} />{e.kind === "defense" && <> — {duration(e.durationSeconds)} under siege</>}</span>
                  <Outcome e={e} />
                </div>
                {/* Phones: a kicker line, then the sentence. */}
                <div className="px-4 py-3.5 text-sm leading-relaxed text-ink-2 lg:hidden">
                  <div className="mb-1.5 flex justify-between font-mono text-[11px] uppercase tracking-[0.12em]">
                    <span className={e.kind === "raid" ? "text-gold" : "text-olive"}>{e.kind === "raid" ? "Raid" : "Defense"} · {timeOf(e.at)}</span>
                    <span className={e.kind === "defense" ? "text-olive" : e.raider ? "text-ink" : "text-muted"}>
                      {e.kind === "defense" ? duration(e.durationSeconds) : e.raider ? `${e.points} pts` : "no clan"}
                    </span>
                  </div>
                  <WarLogLine e={e} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
```

`apps/web/app/(site)/war-log/page.tsx`, replace lines 1-30 (imports through `Outcome`):

```tsx
import type { Metadata } from "next";
import { warLog, type WarLogEntry } from "@factions/roster";
import { EMPTY_WAR_LOG, duration } from "@/lib/scoring-copy";
import { WarLogLine } from "./entry";
import { Page, PageHead, Body, Panel, SegNav, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — war log" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const dayOf = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const timeOf = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Entries grouped by UTC day, newest first — the roster already sorts them. */
function byDay(entries: WarLogEntry[]): [string, WarLogEntry[]][] {
  const out: [string, WarLogEntry[]][] = [];
  for (const e of entries) {
    const day = dayOf(e.at);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e); else out.push([day, [e]]);
  }
  return out;
}

function Outcome({ e }: { e: WarLogEntry }) {
  if (e.kind === "defense") return <span className={`${kickerSm} !text-olive`}>Defended</span>;
  if (!e.raider) return <span className="font-mono text-[11px] text-muted">—</span>;
  return <span className="font-display text-lg text-ink">{e.points} <span className="font-mono text-[11px] text-muted">pts</span></span>;
}
```

with:

```tsx
import type { Metadata } from "next";
import { warLog } from "@factions/roster";
import { EMPTY_WAR_LOG } from "@/lib/scoring-copy";
import { WarLogDays } from "./entry";
import { Page, PageHead, Body, Panel, SegNav } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — war log" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";
```

and replace the panel (from `<Panel>` through its `</Panel>`, originally lines 61-88):

```tsx
            <Panel>
              {byDay(entries).map(([day, list]) => (
```

…down to the closing:

```tsx
              ))}
            </Panel>
```

with:

```tsx
            <Panel>
              <WarLogDays entries={entries} />
            </Panel>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/war-log-days.test.ts && npx tsc --noEmit`
Expected: PASS, with no unused-import errors.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/war-log/entry.tsx" "apps/web/app/(site)/war-log/page.tsx" apps/web/test/war-log-days.test.ts
git commit -m "fix(web): make the war log's days headings and its entries lists

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Every time says UTC, and the award page renders one time everywhere (M5)

**Files:**
- Modify: `apps/web/app/(site)/war-log/entry.tsx:31-40` (`WarLogKicker`)
- Modify: `apps/web/app/components/player-feed.tsx:1-7,40`
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx:5-14`
- Test: `apps/web/test/utc-times.test.ts`; `apps/web/test/award-render.test.tsx` (append)

**Interfaces:**
- Consumes: `when(d: Date): string` from `@/lib/format`, which re-exports `@factions/copy`. It formats as en-GB in UTC with a `" UTC"` suffix.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/utc-times.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlayerFeed, WarLogEntry } from "@factions/roster";
import { WarLogKicker } from "../app/(site)/war-log/entry";
import { PlayerFeedPanel } from "../app/components/player-feed";
import { when } from "../lib/format";

const AT = new Date("2026-09-07T22:14:00Z");

/** M5: `when()` says UTC; the war-log kicker (landing, clan pages) and the player feed printed the same UTC clock without saying so. */
describe("every stamp says UTC", () => {
  it("the war-log kicker", () => {
    const e: WarLogEntry = { kind: "raid", at: AT, raider: null, victim: { tag: "BBB", name: "Bravo", texture: "Flag_Wolf" }, gamertag: null, points: 0, lowers: 1 };
    const html = renderToStaticMarkup(createElement(WarLogKicker, { e }));
    expect(html).toContain(when(AT));
    expect(html).toMatch(/UTC/u);
  });

  it("the player feed", () => {
    const feed: PlayerFeed = { gamertag: "Ron", scope: { kind: "all" }, seasons: [], page: 1, perPage: 25, entries: [{ kind: "raised", at: AT }], hasNext: false };
    const html = renderToStaticMarkup(createElement(PlayerFeedPanel, { feed, basePath: "/players/Ron" }));
    expect(html).toContain(when(AT));
  });
});
```

Append to `apps/web/test/award-render.test.tsx`, inside the existing `describe("the award page", …)`, and add `import { when } from "@/lib/format";` to its imports:

```tsx
  /**
   * ⚠️ The page is a client component that is also server-rendered. A
   * `toLocaleString(undefined, …)` in it rendered the server's zone on the
   * first paint and the viewer's on hydration, and swapped the text.
   */
  it("⚠️ says the same time whatever zone renders it", () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      const a = render(view());
      process.env.TZ = "America/Los_Angeles";
      const b = render(view());
      expect(a).toBe(b);
      expect(a).toContain(when(new Date("2026-09-29T12:00:00.000Z")));
    } finally {
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/utc-times.test.ts test/award-render.test.tsx`
Expected: FAIL. The kicker and feed stamps have no "UTC", and the two award renders differ.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/war-log/entry.tsx`, replace lines 1-2 (as left by Task 9):

```tsx
import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";
```

with:

```tsx
import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";
import { when } from "@/lib/format";
```

and replace the kicker:

```tsx
/** "Raid · 7 Sep 22:14" in gold, "Defense · …" in olive. */
export function WarLogKicker({ e, time }: { e: WarLogEntry; time?: string }) {
  const stamp = time ?? e.at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
```

with:

```tsx
/** "Raid · 7 Sep, 22:14 UTC" in gold, "Defense · …" in olive. ⚠️ `when()`, so the clock says which zone it is in — it shows on the landing page and every clan page, beside nothing else that does (M5). */
export function WarLogKicker({ e, time }: { e: WarLogEntry; time?: string }) {
  const stamp = time ?? when(e.at);
```

`apps/web/app/components/player-feed.tsx`, replace lines 1-7:

```tsx
import type { Encounter, FeedEntry, PlayerFeed } from "@factions/roster";
import { EMPTY_FEED, FEED_KIND, FEED_TITLE, FINISHED, FRIENDLY_FIRE_MARK, HUB_MARK, deathCause, shot, steps } from "@/lib/feed-copy";
import { PAGER } from "@/lib/stats-copy";
import { seasonQuery } from "@/lib/board-page";
import { Panel, Pager } from "./ui";

const stamp = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
```

with:

```tsx
import type { Encounter, FeedEntry, PlayerFeed } from "@factions/roster";
import { EMPTY_FEED, FEED_KIND, FEED_TITLE, FINISHED, FRIENDLY_FIRE_MARK, HUB_MARK, deathCause, shot, steps } from "@/lib/feed-copy";
import { PAGER } from "@/lib/stats-copy";
import { seasonQuery } from "@/lib/board-page";
import { when } from "@/lib/format";
import { Panel, Pager } from "./ui";

/** ⚠️ `when()`: an exact log instant, so it says UTC like every other one on the site (M5). */
const stamp = when;
```

In line 40, widen the desktop kicker column for the " UTC" suffix by changing `lg:w-[190px]` to `lg:w-[230px]`:

```tsx
      <span className={`flex gap-2 font-mono text-[11px] uppercase tracking-[0.12em] lg:w-[230px] lg:flex-none ${k.tone}`}>
```

`apps/web/app/(site)/awards/[id]/award-flow.tsx`, replace lines 5 and 14:

```tsx
import { lookupCopy } from "@/lib/copy-lookup";
```

```tsx
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
```

with (line 5):

```tsx
import { lookupCopy } from "@/lib/copy-lookup";
import { when as whenUtc } from "@/lib/format";
```

and (line 14):

```tsx
/**
 * ⚠️ UTC, never the viewer's zone: this client component is also server-
 * rendered, and a zone-dependent string differs between the two renders, so
 * hydration swapped the text under the reader (M5). UTC is also what every
 * other deadline on the site says.
 */
const when = (iso: string) => whenUtc(new Date(iso));
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/utc-times.test.ts test/award-render.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/war-log/entry.tsx" apps/web/app/components/player-feed.tsx "apps/web/app/(site)/awards/[id]/award-flow.tsx" apps/web/test/utc-times.test.ts apps/web/test/award-render.test.tsx
git commit -m "fix(web): say UTC on every log time, render award deadlines in UTC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Clan and player pages say whose page they are in the tab (M6)

**Files:**
- Create: `apps/web/lib/page-titles.ts`
- Modify: `apps/web/app/(site)/clans/[tag]/page.tsx:1-19,34-36`
- Modify: `apps/web/app/(site)/players/[gamertag]/page.tsx:1-23,58-68`
- Test: `apps/web/test/page-titles.test.ts`

**Interfaces:**
- Produces: `clanTitle(c: { name: string; tag: string }): string`, `playerTitle(gamertag: string): string`, and `NOT_FOUND_TITLE: string`.
- Consumes: React `cache`. `generateMetadata` and the page share one memoized read per request.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/page-titles.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clanTitle, playerTitle, NOT_FOUND_TITLE } from "../lib/page-titles";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** M6: every clan tab read "Clan Wars — clan" and every player tab "Clan Wars — player". */
describe("entity page titles", () => {
  it("keeps the site's 'Clan Wars — <thing>' form, with the thing named", () => {
    expect(clanTitle({ name: "Dead Rabbits", tag: "DR" })).toBe("Clan Wars — Dead Rabbits [DR]");
    expect(playerTitle("IGC slide")).toBe("Clan Wars — IGC slide");
    expect(NOT_FOUND_TITLE).toBe("Clan Wars — not found");
  });

  it.each([["clans", "[tag]", "page.tsx"], ["players", "[gamertag]", "page.tsx"]])("%s/%s/%s builds its title from the record", (...p) => {
    const src = read(...p);
    expect(src).toMatch(/export async function generateMetadata\(/u);
    expect(src).not.toMatch(/export const metadata/u);
  });

  it("⚠️ the metadata read and the page read are one memoized call, not two queries", () => {
    expect(read("clans", "[tag]", "page.tsx")).toMatch(/const clanFor = cache\(/u);
    expect(read("players", "[gamertag]", "page.tsx")).toMatch(/const profileFor = cache\(/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/page-titles.test.ts`
Expected: FAIL. `../lib/page-titles` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/web/lib/page-titles.ts`:

```ts
/**
 * <title>s for pages about one thing. The site's form is "Clan Wars — <thing>"
 * (test/kit.test.ts pins it for /kit); for a clan or a player the thing is its
 * NAME, so two open tabs can be told apart (M6). Built from the record the
 * page read, never from the URL: a path segment is attacker-supplied.
 */
export const clanTitle = (c: { name: string; tag: string }) => `Clan Wars — ${c.name} [${c.tag}]`;
export const playerTitle = (gamertag: string) => `Clan Wars — ${gamertag}`;
export const NOT_FOUND_TITLE = "Clan Wars — not found";
```

`apps/web/app/(site)/clans/[tag]/page.tsx`:

Replace lines 1-2:

```tsx
import type { Metadata } from "next";
import { decodeParam } from "@/lib/route-param";
```

with:

```tsx
import type { Metadata } from "next";
import { cache } from "react";
import { decodeParam } from "@/lib/route-param";
import { clanTitle, NOT_FOUND_TITLE } from "@/lib/page-titles";
```

Replace line 17:

```tsx
export const metadata: Metadata = { title: "Clan Wars — clan" };
```

with:

```tsx
/** ⚠️ One read per request: React's `cache` memoizes it across generateMetadata and the page, so the title costs no second query. */
const clanFor = cache((tag: string, viewer: string | null) => clanByTag(tag, viewer));

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }): Promise<Metadata> {
  const session = await currentSession();
  const clan = await clanFor(decodeParam((await params).tag), session?.sub ?? null);
  return { title: clan ? clanTitle(clan) : NOT_FOUND_TITLE };
}
```

Replace line 35:

```tsx
  const clan = await clanByTag(tag, session?.sub ?? null);
```

with:

```tsx
  const clan = await clanFor(tag, session?.sub ?? null);
```

`apps/web/app/(site)/players/[gamertag]/page.tsx`:

Replace lines 1-2:

```tsx
import type { Metadata } from "next";
import { decodeParam } from "@/lib/route-param";
```

with:

```tsx
import type { Metadata } from "next";
import { cache } from "react";
import { decodeParam } from "@/lib/route-param";
import { playerTitle, NOT_FOUND_TITLE } from "@/lib/page-titles";
```

Replace line 23:

```tsx
export const metadata: Metadata = { title: "Clan Wars — player" };
```

with:

```tsx
/**
 * The profile read, memoized per request so generateMetadata and the page
 * share it. ⚠️ Keyed on the RAW `?season=` string, not on a parsed scope:
 * `cache` compares arguments by identity, and two scope objects built in two
 * places would never match.
 */
const profileFor = cache((gamertag: string, season: string | undefined) => {
  const parsed = parseSeasonParam(season);
  return playerProfile(gamertag, parsed === "default" ? { kind: "current" } : parsed);
});

type Params = { params: Promise<{ gamertag: string }>; searchParams: Promise<{ season?: string | string[]; page?: string | string[]; unlink?: string; result?: string }> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { season } = await searchParams;
  const profile = await profileFor(decodeParam((await params).gamertag), typeof season === "string" ? season : undefined);
  // The record's own spelling of the gamertag, never the URL's.
  return { title: profile ? playerTitle(profile.gamertag) : NOT_FOUND_TITLE };
}
```

Replace the page signature (lines 52-57):

```tsx
export default async function PlayerProfilePage({
  params, searchParams,
}: {
  params: Promise<{ gamertag: string }>;
  searchParams: Promise<{ season?: string | string[]; page?: string | string[]; unlink?: string; result?: string }>;
}) {
```

with:

```tsx
export default async function PlayerProfilePage({ params, searchParams }: Params) {
```

and in the `Promise.all` (line 68) replace `playerProfile(gamertag, scope)` with `profileFor(gamertag, typeof season === "string" ? season : undefined)`:

```tsx
  const [profile, feed, session, wall] = await Promise.all([profileFor(gamertag, typeof season === "string" ? season : undefined), playerFeed(gamertag, scope, parsePageParam(rawPage)), currentSession(), achievementsFor({ gamertag }).catch(() => null)]);
```

`parseSeasonParam` of a non-string is `"default"`, so passing `undefined` for an array value leaves behaviour unchanged.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/page-titles.test.ts test/request-time-rendering.test.ts test/kit.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/page-titles.ts "apps/web/app/(site)/clans/[tag]/page.tsx" "apps/web/app/(site)/players/[gamertag]/page.tsx" apps/web/test/page-titles.test.ts
git commit -m "fix(web): name the clan or player in their page's tab title

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Touch targets and spacing: install close, bell's Mark all read, 404 links, owner panels (M8, M7-bell, L5, L6)

**Files:**
- Modify: `apps/web/app/components/install-strip.tsx:72`
- Modify: `apps/web/app/components/notifications-bell.tsx:46` (Task 1 already edited this file — match the snippet)
- Modify: `apps/web/app/not-found.tsx:11-14`
- Modify: `apps/web/app/components/owner.tsx:158,178,213-219`
- Test: `apps/web/test/touch-targets.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/touch-targets.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/auth/session";
import type { Owner } from "../app/components/owner";
import { AccountPanel, AwardsPanel, BoosterKitPanel } from "../app/components/owner";
import NotFound from "../app/not-found";

const SESSION: Session = { sub: "1", name: "Test", avatar: null, guild: true, nextCheckAt: 0, authAt: 0 };
const owner = (o: Partial<Owner> = {}): Owner => ({
  session: SESSION, viewer: { link: null, clan: null, pending: null }, invites: [], requests: [], claim: null,
  next: null, showInvites: false, boosting: true, openAwards: 1, ...o,
});

describe("the install strip's close (M8)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "install-strip.tsx"), "utf8");
  it("⚠️ is 44px wide as well as tall, with the glyph hidden and the name said", () => {
    expect(src).toMatch(/onClick=\{dismiss\}[^>]*min-h-\[44px\][^>]*min-w-\[44px\][^>]*justify-center[^>]*aria-label="Not now"/u);
    expect(src).toContain('<span aria-hidden="true">✕</span>');
  });
});

describe("the bell panel's Mark all read (live: 113×17px on 2026-09-24)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "notifications-bell.tsx"), "utf8");
  it("⚠️ is a 44px target — the FORMS plan fixed the page's copy of this control, the panel's is owned here", () => {
    expect(src).toMatch(/<button type="submit" className="[^"]*min-h-\[44px\][^"]*"[^>]*>Mark all read</u);
  });
});

describe("the root 404 (L5)", () => {
  const html = renderToStaticMarkup(createElement(NotFound));
  it("both links are 44px touch targets", () => {
    const links = [...html.matchAll(/<a [^>]*>/gu)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    for (const a of links) expect(a).toContain("min-h-[44px]");
  });
});

describe("the owner's panels (L6)", () => {
  it("puts air between a panel's sentence and its button", () => {
    expect(renderToStaticMarkup(createElement(BoosterKitPanel, { owner: owner() }))).toMatch(/<a href="\/kit" class="mt-3 /u);
    expect(renderToStaticMarkup(createElement(AwardsPanel, { owner: owner() }))).toMatch(/<a href="\/awards" class="mt-3 /u);
  });

  it("⚠️ stacks the three account links on a phone instead of wrapping each onto three lines", () => {
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner: owner() }));
    expect(html).toContain("grid grid-cols-1 border-t border-rule-2 sm:grid-cols-3");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/touch-targets.test.ts`
Expected: FAIL on all three describes.

- [ ] **Step 3: Implement**

`apps/web/app/components/install-strip.tsx:72`, replace:

```tsx
      <button type="button" onClick={dismiss} className="flex min-h-[44px] flex-none items-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink" aria-label="Not now">✕</button>
```

with:

```tsx
      {/* ⚠️ 44px WIDE as well as tall: the bare glyph was an ~8px-wide target (M8). */}
      <button type="button" onClick={dismiss} className="flex min-h-[44px] min-w-[44px] flex-none items-center justify-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink" aria-label="Not now"><span aria-hidden="true">✕</span></button>
```

`apps/web/app/components/notifications-bell.tsx:46`, replace:

```tsx
            <button type="submit" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink">Mark all read</button>
```

with:

```tsx
            {/* ⚠️ 44px tall: as bare 11px text this was a 17px-high target, measured live. */}
            <button type="submit" className="inline-flex min-h-[44px] items-center font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink">Mark all read</button>
```

`apps/web/app/not-found.tsx`, replace lines 11-14:

```tsx
        <p className="mt-6 flex flex-wrap gap-6 font-mono text-[11px] uppercase tracking-[0.18em]">
          <a className="text-gold underline-offset-4 hover:underline" href="/">The front page</a>
          <a className="text-gold underline-offset-4 hover:underline" href="/guide">The field guide</a>
        </p>
```

with:

```tsx
        {/* Outside (site), so there is no bar here: these two links are the only way on, and each is a full 44px target (L5). */}
        <p className="mt-6 flex flex-wrap gap-x-6 font-mono text-[11px] uppercase tracking-[0.18em]">
          <a className="inline-flex min-h-[44px] items-center text-gold underline-offset-4 hover:underline" href="/">The front page</a>
          <a className="inline-flex min-h-[44px] items-center text-gold underline-offset-4 hover:underline" href="/guide">The field guide</a>
        </p>
```

`apps/web/app/components/owner.tsx`:

Line 158:

```tsx
        <a href="/kit" className={btnPrimary}>Open your kit</a>
```

becomes

```tsx
        <a href="/kit" className={`mt-3 ${btnPrimary}`}>Open your kit</a>
```

Line 178:

```tsx
        <a href="/awards" className={btnPrimary}>Open your awards</a>
```

becomes

```tsx
        <a href="/awards" className={`mt-3 ${btnPrimary}`}>Open your awards</a>
```

Lines 213-219:

```tsx
      ) : (
        <div className="grid grid-cols-3 border-t border-rule-2">
          <a className={`${cell} border-r border-rule-2`} href="/base">Solo base <span className="text-gold">→</span></a>
          <a className={`${cell} border-r border-rule-2`} href="/map">The map <span className="text-gold">→</span></a>
          <a className={cell} href="/clans">Browse the clans <span className="text-gold">→</span></a>
        </div>
      )}
```

become

```tsx
      ) : (
        // ⚠️ One column on a phone: three columns at 375px wrapped "Browse the clans →" onto three lines (L6).
        <div className="grid grid-cols-1 border-t border-rule-2 sm:grid-cols-3">
          <a className={`${cell} border-b border-rule-2 sm:border-b-0 sm:border-r`} href="/base">Solo base <span className="text-gold">→</span></a>
          <a className={`${cell} border-b border-rule-2 sm:border-b-0 sm:border-r`} href="/map">The map <span className="text-gold">→</span></a>
          <a className={cell} href="/clans">Browse the clans <span className="text-gold">→</span></a>
        </div>
      )}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/touch-targets.test.ts test/owner-kit.test.ts test/install.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/install-strip.tsx apps/web/app/components/notifications-bell.tsx apps/web/app/not-found.tsx apps/web/app/components/owner.tsx apps/web/test/touch-targets.test.ts
git commit -m "fix(web): full-size touch targets on the install close, the bell's Mark all read and 404 links, stack owner links on phones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: /scoreboard on a phone gives the names room (S1)

**Files:**
- Create: `apps/web/app/components/score-rows.tsx`
- Modify: `apps/web/app/(site)/scoreboard/page.tsx:1-8,66-96`
- Test: `apps/web/test/score-rows.test.ts`

**Interfaces:**
- Produces: `PhoneRows({ rows }: { rows: ScoreboardRow[] })`.
- Consumes: `ScoreboardRow` (`@factions/roster`), `flagThumbPath`, `Rank` and `kickerSm` (ui.tsx), and `ALPHA_BADGE`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/score-rows.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScoreboardRow } from "@factions/roster";
import { CLAN_NAME_LENGTH } from "@factions/domain";
import { PhoneRows } from "../app/components/score-rows";

const row = (o: Partial<ScoreboardRow> = {}): ScoreboardRow => ({
  rank: 1, tag: "DR", name: "Dead Rabbits", texture: "Flag_Wolf", status: "active",
  points: 400, raids: 2, timesRaided: 1, defenses: 1, alpha: false, ...o,
});

/**
 * S1 (confirmed live at 375px): names truncated to "Dead R…" while the
 * "R / RD / D" column had room to spare, the header wrapped onto two lines,
 * and the tag was hidden. The counts now sit on a second line under the name.
 */
describe("/scoreboard's phone rows", () => {
  const html = renderToStaticMarkup(createElement(PhoneRows, { rows: [row(), row({ rank: 2, tag: "WWW", name: "W".repeat(CLAN_NAME_LENGTH.max) })] }));

  it("⚠️ gives the name the whole middle column, and the header never wraps", () => {
    expect(html).toContain("grid-cols-[32px_minmax(0,1fr)_auto]");
    expect(html).not.toContain("R / Rd / D");
    expect(html).toMatch(/aria-hidden="true" class="[^"]*whitespace-nowrap/u);
  });

  it("⚠️ a 32-character name wraps onto two lines inside its column instead of pushing the points off-screen", () => {
    expect(html).toMatch(/class="[^"]*line-clamp-2[^"]*\[overflow-wrap:anywhere\][^"]*">W{32}</u);
  });

  it("shows the tag and the counts in words on the phone", () => {
    expect(html).toContain("[DR]");
    expect(html).toContain("2 raids");
    expect(html).toContain("raided 1×");
    expect(html).toContain("1 defense");
  });

  it("names the points for a screen reader and lines numbers up", () => {
    expect(html).toMatch(/400<span class="sr-only"> points<\/span>/u);
    expect(html).toContain("tabular-nums");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/score-rows.test.ts`
Expected: FAIL. `../app/components/score-rows` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/web/app/components/score-rows.tsx`:

```tsx
import type { ScoreboardRow } from "@factions/roster";
import { flagThumbPath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Rank, kickerSm } from "./ui";

/** "1 raid" / "2 raids". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * /scoreboard on a phone: rank | clan | points, with the clan's tag and its
 * raids, times raided and defenses on a second line under the name.
 *
 * ⚠️ The counts used to be a fourth column ("R / Rd / D"), which squeezed the
 * name to six characters and wrapped the header onto two lines at 375px (S1).
 * Under the name they cost no width. The name itself may take two lines and
 * breaks anywhere: a clan name can be CLAN_NAME_LENGTH.max characters with no
 * space, wider than the column in Archivo Black.
 */
export function PhoneRows({ rows }: { rows: ScoreboardRow[] }) {
  const cols = "grid grid-cols-[32px_minmax(0,1fr)_auto] gap-2.5";
  return (
    <>
      {/* Visual only: every value below says what it is to a screen reader. */}
      <div aria-hidden="true" className={`${cols} whitespace-nowrap border-b-2 border-rule-2 px-4 py-2.5 ${kickerSm} !text-dim`}>
        <span>#</span><span>Clan</span><span className="text-right">Pts</span>
      </div>
      <ul>
        {rows.map((r) => {
          const dormant = r.status === "dormant";
          return (
            <li key={r.tag} className={`${cols} min-h-[60px] items-center border-t border-rule-2 px-4 py-2 first:border-t-0`}>
              <Rank n={r.rank} size="lg" />
              <a className="flex min-w-0 items-center gap-2.5" href={`/clans/${encodeURIComponent(r.tag)}`}>
                <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={28} height={28} className={`h-7 w-7 flex-none object-contain ${dormant ? "opacity-60" : ""}`} />
                <span className="min-w-0">
                  <span className={`line-clamp-2 [overflow-wrap:anywhere] font-display text-[15px] leading-tight ${dormant ? "text-ink-2" : "text-ink"}`}>{r.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] tabular-nums text-muted">
                    <span className="text-ink-2">[{r.tag}]</span>
                    <span>{count(r.raids, "raid", "raids")}</span>
                    <span>raided {r.timesRaided}×</span>
                    <span>{count(r.defenses, "defense", "defenses")}</span>
                    {r.alpha && <span className="uppercase text-gold">{ALPHA_BADGE}</span>}
                    {dormant && <span className="uppercase">Dormant</span>}
                  </span>
                </span>
              </a>
              <span className={`text-right font-display text-xl tabular-nums ${dormant ? "text-muted" : "text-ink"}`}>{r.points}<span className="sr-only"> points</span></span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
```

`apps/web/app/(site)/scoreboard/page.tsx`:

Replace line 7:

```tsx
import { Page, PageHead, Body, Panel, Rank, kickerSm } from "@/app/components/ui";
```

with:

```tsx
import { Page, PageHead, Body, Panel, Rank } from "@/app/components/ui";
import { PhoneRows } from "@/app/components/score-rows";
```

Replace the phone panel and the legend (lines 66-96, from `{/* Phones: the same rows as a grid list, R / Rd / D compressed. */}` through the closing `</p>`):

```tsx
            {/* Phones: one row per clan, the counts under the name (S1). */}
            <Panel className="lg:hidden">
              <PhoneRows rows={rows} />
            </Panel>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-muted">
              {season.weekClosedThrough ? `Alphas through the week of ${when(season.weekClosedThrough)}.` : "No week has closed yet."}
              <span className="hidden lg:inline"> Only raids score; the higher the victim, the more it is worth.</span>
            </p>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/score-rows.test.ts test/flag-thumbs.test.ts test/table-semantics.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/score-rows.tsx "apps/web/app/(site)/scoreboard/page.tsx" apps/web/test/score-rows.test.ts
git commit -m "fix(web): give clan names the width on the phone scoreboard, counts under the name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Links and numbers say what they are (M9, M10)

**Files:**
- Modify: `apps/web/app/components/score-rows.tsx` (append `TopRows`)
- Modify: `apps/web/app/(site)/page.tsx:8,75-101`
- Modify: `apps/web/app/components/stat-boards.tsx:60-62`
- Modify: `apps/web/app/(site)/clans/[tag]/page.tsx:113`
- Test: `apps/web/test/link-names.test.ts`

**Interfaces:**
- Produces: `TopRows({ rows }: { rows: ScoreboardRow[] })`, the landing page's top five.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/link-names.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOARD_KINDS, type Boards, type ScoreboardRow } from "@factions/roster";
import { StatBoards } from "../app/components/stat-boards";
import { TopRows } from "../app/components/score-rows";
import { BOARD_LABELS } from "../lib/stats-copy";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** M9: ten identical "See all" links on /players, and "All →" twice more — indistinguishable in a screen reader's link list. */
describe("every link names where it goes", () => {
  const boards = { clans: {}, scope: { kind: "season", number: 1 }, seasons: [1], ...Object.fromEntries(BOARD_KINDS.map((k) => [k, []])) } as unknown as Boards;
  const html = renderToStaticMarkup(createElement(StatBoards, { boards, boardsPath: "/players/boards" }));

  it("⚠️ each See all carries its board's name", () => {
    for (const kind of BOARD_KINDS) expect(html).toContain(`<span class="sr-only">: ${BOARD_LABELS[kind]}</span>`);
  });

  it("the landing and clan pages' All links say whose log", () => {
    expect(read("page.tsx")).toMatch(/All<span className="sr-only"> war log entries<\/span>/u);
    // `&apos;` is how the JSX source spells the apostrophe; this reads the source.
    expect(read("clans", "[tag]", "page.tsx")).toMatch(/All<span className="sr-only"> of this clan&apos;s war log<\/span>/u);
  });
});

/** M10 (confirmed live): the landing scoreboard read "400 2 1" — three bare numbers. */
describe("the landing page's scoreboard rows", () => {
  const row: ScoreboardRow = { rank: 1, tag: "DR", name: "Dead Rabbits", texture: "Flag_Wolf", status: "active", points: 400, raids: 2, timesRaided: 1, defenses: 1, alpha: false };
  const html = renderToStaticMarkup(createElement(TopRows, { rows: [row] }));

  it("has a column header", () => {
    expect(html).toMatch(/aria-hidden="true"[^>]*>.*Pts.*Raids.*Def/u);
  });

  it("⚠️ says what each number is to a screen reader", () => {
    expect(html).toContain('400<span class="sr-only"> points</span>');
    expect(html).toContain('2<span class="sr-only"> raids</span>');
    expect(html).toContain('1<span class="sr-only"> defenses</span>');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/link-names.test.ts`
Expected: FAIL. `TopRows` is not exported, and there is no sr-only board label.

- [ ] **Step 3: Implement**

Append to `apps/web/app/components/score-rows.tsx`:

```tsx

/**
 * The landing page's top five: rank, flag, name, then points (and, from lg,
 * raids and defenses). ⚠️ The numbers carry their unit for a screen reader
 * and the header row names them for everyone: the row used to read "400 2 1"
 * (M10). The header is aria-hidden because the units already say it.
 */
export function TopRows({ rows }: { rows: ScoreboardRow[] }) {
  return (
    <>
      <div aria-hidden="true" className={`flex items-center gap-3 border-b border-rule-2 px-4 py-2 lg:gap-4 lg:px-5 ${kickerSm} !text-dim`}>
        <span className="w-5 lg:w-7">#</span>
        <span className="w-7 lg:w-8" />
        <span>Clan</span>
        <span className="ml-auto">Pts</span>
        <span className="hidden w-12 text-right lg:block">Raids</span>
        <span className="hidden w-12 text-right lg:block">Def</span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.tag} className="flex min-h-[56px] items-center gap-3 border-t border-rule-2 px-4 first:border-t-0 lg:min-h-[64px] lg:gap-4 lg:px-5">
            <span className="w-5 lg:w-7"><Rank n={r.rank} size="lg" /></span>
            <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={32} height={32} className={`h-7 w-7 object-contain lg:h-8 lg:w-8 ${r.status === "dormant" ? "opacity-60" : ""}`} />
            <a href={`/clans/${encodeURIComponent(r.tag)}`} className="min-w-0">
              <span className={`block truncate font-display text-[15px] lg:text-base ${r.status === "dormant" ? "text-ink-2" : "text-ink"}`}>{r.name}</span>
              <span className="font-mono text-[11px] text-ink-2">
                <span className="hidden lg:inline">[{r.tag}]</span>
                {r.alpha && <><span className="hidden lg:inline"> · </span><span className="uppercase text-gold">{ALPHA_BADGE}</span></>}
                {r.status === "dormant" && <><span className="hidden lg:inline"> · </span><span className="uppercase text-muted">dormant</span></>}
              </span>
            </a>
            <span className="ml-auto font-display text-lg tabular-nums text-ink lg:text-xl">{r.points}<span className="sr-only"> points</span></span>
            <span className="hidden w-12 text-right font-mono text-sm tabular-nums text-ink-2 lg:block">{r.raids}<span className="sr-only"> raids</span></span>
            <span className="hidden w-12 text-right font-mono text-sm tabular-nums text-ink-2 lg:block">{r.defenses}<span className="sr-only"> defenses</span></span>
          </li>
        ))}
      </ul>
    </>
  );
}
```

`apps/web/app/(site)/page.tsx`:

After line 9 (`import { HeroMap } …`) add:

```tsx
import { TopRows } from "@/app/components/score-rows";
```

Replace the scoreboard `<ul>…</ul>` (from `<ul>` after `) : (` in the Scoreboard panel through its `</ul>`, as left by Task 3) with:

```tsx
            <TopRows rows={top} />
```

so the panel body reads:

```tsx
          {top.length === 0 ? (
            <p className="p-5 text-sm text-ink-2">{board.season ? "Nobody has scored yet." : EMPTY_SCOREBOARD}</p>
          ) : (
            <TopRows rows={top} />
          )}
```

Remove `Rank` from the ui import on line 8 (it is no longer used on the page):

```tsx
import { Page, Panel, Stat, Footer, btnCta, linkMono, kicker } from "@/app/components/ui";
```

Replace the War log panel's aside (line 101):

```tsx
          <Panel num="02" title="War log" aside={<a className={linkMono} href="/war-log">All →</a>}>
```

with:

```tsx
          <Panel num="02" title="War log" aside={<a className={linkMono} href="/war-log">All<span className="sr-only"> war log entries</span> <span aria-hidden="true">→</span></a>}>
```

`apps/web/app/components/stat-boards.tsx`, replace lines 60-62:

```tsx
      <p className="mt-auto border-t border-rule-2 px-4 lg:px-5">
        <a className={`${linkMono} inline-flex min-h-[44px] items-center`} href={seeAll}>{SEE_ALL} &rarr;</a>
      </p>
```

with:

```tsx
      <p className="mt-auto border-t border-rule-2 px-4 lg:px-5">
        {/* ⚠️ Ten of these on /players: the board's name makes each one distinct in a screen reader's link list (M9). */}
        <a className={`${linkMono} inline-flex min-h-[44px] items-center`} href={seeAll}>{SEE_ALL}<span className="sr-only">: {BOARD_LABELS[kind]}</span>&nbsp;<span aria-hidden="true">&rarr;</span></a>
      </p>
```

`apps/web/app/(site)/clans/[tag]/page.tsx:113`, replace:

```tsx
        <Panel title="War log" aside={<a className={linkMono} href={logHref}>All →</a>} className="lg:col-span-3">
```

with:

```tsx
        <Panel title="War log" aside={<a className={linkMono} href={logHref}>All<span className="sr-only"> of this clan&apos;s war log</span> <span aria-hidden="true">→</span></a>} className="lg:col-span-3">
```

JSX renders `&apos;` as `'` on the page. The test reads the source, so it matches `&apos;`.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/link-names.test.ts test/score-rows.test.ts test/flag-thumbs.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/score-rows.tsx "apps/web/app/(site)/page.tsx" apps/web/app/components/stat-boards.tsx "apps/web/app/(site)/clans/[tag]/page.tsx" apps/web/test/link-names.test.ts
git commit -m "fix(web): name every See all and All link, label the landing scoreboard's numbers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Long clan names fit the /clans rows on a phone (M11)

**Files:**
- Create: `apps/web/app/(site)/clans/rows.tsx`
- Modify: `apps/web/app/(site)/clans/page.tsx:1-8,18,31-49,63-78`
- Test: `apps/web/test/clan-rows.test.ts`

**Interfaces:**
- Produces: `RecruitingRow({ c }: { c: DirectoryEntry })` and `ClanRow({ c }: { c: DirectoryEntry })`. Each renders one `<li>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/clan-rows.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectoryEntry } from "@factions/roster";
import { CLAN_NAME_LENGTH } from "@factions/domain";
import { ClanRow, RecruitingRow } from "../app/(site)/clans/rows";

const LONG = "W".repeat(CLAN_NAME_LENGTH.max);
const clan = (o: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  tag: "WWW", name: LONG, texture: "Flag_Wolf", status: "active", memberCount: 7,
  recruiting: true, playWindow: "Evenings UTC", language: "English", pitch: null, alpha: true, ...o,
});

/**
 * M11: a CLAN_NAME_LENGTH.max name with no space, in Archivo Black at 15px,
 * is ~350px — wider than a phone's row. A flex item without min-w-0 will not
 * shrink below its longest word and pushes the member count off-screen.
 */
describe("/clans rows with a 32-character name", () => {
  it.each([["Every clan", ClanRow], ["Recruiting", RecruitingRow]] as const)("%s: ⚠️ the name shrinks and breaks anywhere", (_, Row) => {
    const html = renderToStaticMarkup(createElement(Row, { c: clan() }));
    expect(html).toMatch(new RegExp(`class="[^"]*min-w-0[^"]*\\[overflow-wrap:anywhere\\][^"]*">${LONG}<`, "u"));
  });

  it.each([["Every clan", ClanRow], ["Recruiting", RecruitingRow]] as const)("%s: the count and badges never shrink", (_, Row) => {
    const html = renderToStaticMarkup(createElement(Row, { c: clan() }));
    expect(html).toMatch(/class="ml-auto flex-none[^"]*">7/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/clan-rows.test.ts`
Expected: FAIL. `../app/(site)/clans/rows` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/web/app/(site)/clans/rows.tsx`:

```tsx
import type { DirectoryEntry } from "@factions/roster";
import { flagThumbPath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Facts, kickerSm } from "@/app/components/ui";

const href = (tag: string) => `/clans/${encodeURIComponent(tag)}`;

/**
 * ⚠️ `min-w-0` AND `[overflow-wrap:anywhere]` on every name here (M11). A
 * clan name can be CLAN_NAME_LENGTH.max characters with no space, wider than
 * a phone in Archivo Black; without min-w-0 the flex item refuses to shrink
 * below that word, and without overflow-wrap it cannot break once it does.
 * Everything else in the row is `flex-none`, so only the name gives.
 */
const NAME = "min-w-0 [overflow-wrap:anywhere]";

/** One recruiting clan: the row, then its play window, language and pitch. */
export function RecruitingRow({ c }: { c: DirectoryEntry }) {
  return (
    <li className="border-t border-rule-2 px-4 py-3.5 first:border-t-0 lg:px-5 lg:py-4">
      <a className="flex items-center gap-3 text-ink" href={href(c.tag)}>
        <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={40} height={40} className="h-9 w-9 flex-none object-contain lg:h-10 lg:w-10" />
        <span className={`${NAME} font-display text-base lg:text-lg`}>{c.name}</span>
        <span className="hidden flex-none font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
        <span className="ml-auto flex-none font-mono text-[11px] text-muted">{c.memberCount} members</span>
      </a>
      {(c.playWindow || c.language || c.pitch) && (
        <Facts className="mt-3" items={[
          ...(c.playWindow ? [["Plays", c.playWindow] as [React.ReactNode, React.ReactNode]] : []),
          ...(c.language ? [["Speaks", c.language] as [React.ReactNode, React.ReactNode]] : []),
          ...(c.pitch ? [["Pitch", <span key="p" className="text-ink">{c.pitch}</span>] as [React.ReactNode, React.ReactNode]] : []),
        ]} />
      )}
    </li>
  );
}

/** One clan in "Every clan": flag, name, badges, member count. */
export function ClanRow({ c }: { c: DirectoryEntry }) {
  const dormant = c.status === "dormant";
  return (
    <li className="border-t border-rule-2 first:border-t-0">
      <a className={`flex min-h-[56px] items-center gap-3 px-4 lg:min-h-[60px] lg:gap-3.5 lg:px-5 ${dormant ? "text-ink-2" : "text-ink"}`} href={href(c.tag)}>
        <img src={`/${flagThumbPath(c.texture)}`} alt="" loading="lazy" width={32} height={32} className={`h-7 w-7 flex-none object-contain lg:h-8 lg:w-8 ${dormant ? "opacity-60" : ""}`} />
        <span className={`${NAME} font-display text-[15px] lg:text-base`}>{c.name}</span>
        <span className="hidden flex-none font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
        {c.alpha && <span className={`${kickerSm} flex-none !text-gold`}>{ALPHA_BADGE}</span>}
        {dormant && <span className={`${kickerSm} flex-none`}>dormant</span>}
        <span className="ml-auto flex-none font-mono text-[13px] tabular-nums text-ink-2">{c.memberCount}</span>
      </a>
    </li>
  );
}
```

The test regex expects the member count as `class="ml-auto flex-none[^"]*">7`. In `RecruitingRow` that span is `ml-auto flex-none font-mono text-[11px] text-muted">7 members`, and in `ClanRow` it is `ml-auto flex-none font-mono … text-ink-2">7`. Both match.

`apps/web/app/(site)/clans/page.tsx`:

Replace lines 1-7:

```tsx
import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagThumbPath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Page, PageHead, Panel, Facts, kicker, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
```

with:

```tsx
import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagThumbPath } from "@/src/flag-images";
import { Page, PageHead, Panel, kicker } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
import { ClanRow, RecruitingRow } from "./rows";
```

Delete line 18:

```tsx
  const href = (tag: string) => `/clans/${encodeURIComponent(tag)}`;
```

Replace the recruiting `<ul>` body (`{recruiting.map((c) => ( <li …> … </li> ))}`, originally lines 32-48) with:

```tsx
                {recruiting.map((c) => <RecruitingRow key={c.tag} c={c} />)}
```

Replace the Every clan `<ul>` body (`{clans.map((c) => { … })}`, originally lines 64-78) with:

```tsx
            {clans.map((c) => <ClanRow key={c.tag} c={c} />)}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/clan-rows.test.ts test/flag-thumbs.test.ts test/copy-vocabulary.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/clans/rows.tsx" "apps/web/app/(site)/clans/page.tsx" apps/web/test/clan-rows.test.ts
git commit -m "fix(web): let long clan names wrap in the /clans rows instead of overflowing a phone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The award page has a way back, the site's head, and visible empty slots (M12)

**Files:**
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx:8,83-89,124,144-147`
- Test: `apps/web/test/award-render.test.tsx` (append)

**Interfaces:** Consumes `PageHead` and `BackLine` from `@/app/components/ui`, a module that is safe for client components (no server-only imports).

- [ ] **Step 1: Write the failing test**

Append inside `describe("the award page", …)` in `apps/web/test/award-render.test.tsx`:

```tsx
  it("has the site's page head and a way back to the awards list (M12)", () => {
    const html = render(view());
    expect(html).toMatch(/<h1[^>]*>Plate Carrier<\/h1>/u);
    expect(html).toContain("border-b-2 border-rule-2 px-5 pb-5 pt-6"); // PageHead's own frame
    expect(html).toMatch(/<a class="[^"]*" href="\/awards">← Your awards<\/a>/u);
  });

  it("⚠️ draws an empty slot's edge at control contrast (rule-3), not panel contrast", () => {
    const html = render(view());
    expect(html).toContain("border-dashed border-rule-3");
    expect(html).not.toContain("border-dashed border-rule-2");
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/award-render.test.tsx`
Expected: FAIL. There is no PageHead frame, no `/awards` link, and the empty-slot edge is `border-rule-2`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/awards/[id]/award-flow.tsx`:

Line 8:

```tsx
import { Page, btnCta, btnPrimary, kicker } from "@/app/components/ui";
```

becomes

```tsx
import { BackLine, Page, PageHead, btnCta, btnPrimary } from "@/app/components/ui";
```

Replace lines 83-89:

```tsx
      <Page>
        <div className="px-4 pb-28 pt-5 lg:px-8 lg:pb-16 lg:pt-7">
          <div className={kicker}>Event award</div>
          <h1 className="mt-1.5 font-display text-[38px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">{view.label}</h1>
          <p className="mt-2 text-sm text-ink-2">{view.reason}</p>

          <div className="mt-4 border border-rule-2 bg-frame p-3.5">
```

with:

```tsx
      <Page>
        {/* The site's own head, like every other page, instead of a hand-built one (M12). */}
        <PageHead kicker="Event award" title={view.label} sub={view.reason} />
        <div className="px-5 pb-28 pt-5 lg:px-8 lg:pb-16 lg:pt-6">
          <div className="border border-rule-2 bg-frame p-3.5">
```

In line 124, change the empty slot's `border border-dashed border-rule-2` to `border border-dashed border-rule-3`:

```tsx
                  className={`flex min-h-[116px] flex-col items-stretch p-2 text-left lg:min-h-[170px] lg:p-3 ${e ? "border border-rule-2 bg-frame" : "border border-dashed border-rule-3"} disabled:cursor-default`}>
```

Above that `<button` (after `const e = entry(slot);` and `return (`), add one comment line:

```tsx
                // ⚠️ An empty slot's dashed edge is its only affordance, so it is a CONTROL edge (rule-3, 3.2:1), not a panel's (rule-2, 1.34:1).
```

Replace lines 144-147:

```tsx
          <ul className="mt-6 flex max-w-[34rem] flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            {GROUND_RULES.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
```

with:

```tsx
          <ul className="mt-6 flex max-w-[34rem] flex-col gap-2 text-[13px] leading-relaxed text-ink-2">
            {GROUND_RULES.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <BackLine href="/awards">Your awards</BackLine>
        </div>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/award-render.test.tsx test/text-floor.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/awards/[id]/award-flow.tsx" apps/web/test/award-render.test.tsx
git commit -m "fix(web): give the award page the site's head, a way back, and visible empty slots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Number columns line up (L1)

**Files:**
- Modify: `apps/web/app/components/stat-boards.tsx:45,47`
- Modify: `apps/web/app/(site)/scoreboard/page.tsx:15,56`
- Modify: `apps/web/app/(site)/seasons/page.tsx:15,60`
- Modify: `apps/web/app/(site)/alphas/page.tsx:37`
- Test: `apps/web/test/tabular-nums.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/tabular-nums.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardRows } from "../app/components/stat-boards";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** L1: proportional digits make a right-aligned column of numbers ragged. */
describe("number columns use tabular figures", () => {
  it("a board's value and K/D", () => {
    const html = renderToStaticMarkup(createElement(BoardRows, { kind: "kd", rows: [{ dayzId: "1", gamertag: "Ron", value: 2.5, kills: 10, deaths: 4 }], clans: {} }));
    expect([...html.matchAll(/tabular-nums/gu)].length).toBeGreaterThanOrEqual(2);
  });

  it.each([["scoreboard"], ["seasons"]])("/%s's number cells", (p) => {
    const src = read(p, "page.tsx");
    expect(src).toMatch(/const num = "[^"]*tabular-nums/u);
    expect(src).toMatch(/text-right font-display[^"`]*tabular-nums/u);
  });

  it("/alphas's points", () => {
    expect(read("alphas", "page.tsx")).toMatch(/ml-auto font-display[^"]*tabular-nums/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/tabular-nums.test.ts`
Expected: FAIL. None of these cells has `tabular-nums`.

- [ ] **Step 3: Implement**

`apps/web/app/components/stat-boards.tsx`, line 45:

```tsx
            {kind === "kd" && "kills" in r && <span className="ml-auto font-mono text-xs text-muted">{r.kills} / {r.deaths}</span>}
```

becomes

```tsx
            {kind === "kd" && "kills" in r && <span className="ml-auto font-mono text-xs tabular-nums text-muted">{r.kills} / {r.deaths}</span>}
```

Line 47:

```tsx
            <span className={`${kind === "kd" ? "w-11 text-right" : kind === "longestKills" && "weapon" in r && r.weapon ? "w-20 flex-none text-right" : "ml-auto"} ${podium ? "font-display text-base text-ink" : "font-mono text-sm text-ink-2"}`}>{boardValue(kind, r.value)}</span>
```

becomes

```tsx
            <span className={`${kind === "kd" ? "w-11 text-right" : kind === "longestKills" && "weapon" in r && r.weapon ? "w-20 flex-none text-right" : "ml-auto"} tabular-nums ${podium ? "font-display text-base text-ink" : "font-mono text-sm text-ink-2"}`}>{boardValue(kind, r.value)}</span>
```

`apps/web/app/(site)/scoreboard/page.tsx`, line 15:

```tsx
const num = "px-6 text-right font-mono text-sm text-ink-2";
```

becomes

```tsx
/** ⚠️ tabular-nums: a right-aligned column of proportional digits is ragged (L1). */
const num = "px-6 text-right font-mono text-sm tabular-nums text-ink-2";
```

Line 56:

```tsx
                        <td className={`px-6 text-right font-display text-2xl ${dormant ? "text-muted" : "text-ink"}`}>{r.points}</td>
```

becomes

```tsx
                        <td className={`px-6 text-right font-display text-2xl tabular-nums ${dormant ? "text-muted" : "text-ink"}`}>{r.points}</td>
```

`apps/web/app/(site)/seasons/page.tsx`, line 15:

```tsx
const num = "px-4 text-right font-mono text-sm text-ink-2 lg:px-6";
```

becomes

```tsx
/** ⚠️ tabular-nums: a right-aligned column of proportional digits is ragged (L1). */
const num = "px-4 text-right font-mono text-sm tabular-nums text-ink-2 lg:px-6";
```

Line 60:

```tsx
                      <td className="px-4 text-right font-display text-lg text-ink lg:px-6">{r.points}</td>
```

becomes

```tsx
                      <td className="px-4 text-right font-display text-lg tabular-nums text-ink lg:px-6">{r.points}</td>
```

`apps/web/app/(site)/alphas/page.tsx`, line 37:

```tsx
                    <span className="ml-auto font-display text-base text-ink lg:text-lg">{e.points} <span className="hidden font-mono text-[11px] text-muted lg:inline">pts</span></span>
```

becomes

```tsx
                    <span className="ml-auto font-display text-base tabular-nums text-ink lg:text-lg">{e.points} <span className="hidden font-mono text-[11px] text-muted lg:inline">pts</span></span>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/tabular-nums.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/stat-boards.tsx "apps/web/app/(site)/scoreboard/page.tsx" "apps/web/app/(site)/seasons/page.tsx" "apps/web/app/(site)/alphas/page.tsx" apps/web/test/tabular-nums.test.ts
git commit -m "fix(web): tabular figures on every number column

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: No raw hex in the hero map or the locked badge (L2)

**Files:**
- Modify: `apps/web/app/components/hero-map.tsx:47-90`
- Modify: `apps/web/app/components/achievement-badge.tsx:5-10,25-55`
- Modify: `apps/web/test/achievement-badge.test.ts:26-34`
- Modify: `apps/web/test/achievement-wall.test.ts:43`
- Update: `apps/web/test/__snapshots__/achievement-wall.test.ts.snap` (regenerated)
- Test: `apps/web/test/raw-hex.test.ts`

**Interfaces:** `AchievementBadge` keeps its props. Only the locked and progress states' markup changes. The unlocked state is unchanged, because the OG share card renders it through `next/og`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/raw-hex.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "app", "components", f), "utf8");

/**
 * L2: colours come from the @theme tokens. A hex literal is a second statement
 * of a palette colour that nothing holds to the first — #4a4640 was not a
 * palette colour at all.
 */
describe("no raw hex colours", () => {
  it.each(["hero-map.tsx", "achievement-badge.tsx"])("%s states no hex colour", (f) => {
    expect(read(f)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });
});
```

Update `apps/web/test/achievement-badge.test.ts`. Replace the test `"colours by group when unlocked, grey when locked, and never names a coordinate"`:

```ts
  it("colours by group when unlocked, grey when locked, and never names a coordinate", () => {
    const unlocked = render({ state: "unlocked", group: "pve" });
    expect(unlocked).toContain('stroke="#8fa36a"');
    expect(unlocked).toContain('fill="#8fa36a1f"');
    const locked = render({ state: "locked", group: "pve" });
    expect(locked).not.toContain("#8fa36a");
    expect(locked).toContain('stroke="#4a4640"');
    expect(render({ state: "progress", group: "pve" })).toContain('stroke="#8a857c"');
  });
```

with:

```ts
  it("colours by group when unlocked, grey when locked, and never names a coordinate", () => {
    // ⚠️ Unlocked stays hex ATTRIBUTES: the share card draws it through next/og, which resolves no CSS.
    const unlocked = render({ state: "unlocked", group: "pve" });
    expect(unlocked).toContain('stroke="#8fa36a"');
    expect(unlocked).toContain('fill="#8fa36a1f"');
    // Locked and progress are site-only, so they take the palette's tokens as classes.
    const locked = render({ state: "locked", group: "pve" });
    expect(locked).not.toContain("#8fa36a");
    expect(locked).toContain('class="fill-frame stroke-rule-2"');
    expect(locked).toContain('class="stroke-rule-3"');
    expect(render({ state: "progress", group: "pve" })).toContain('class="stroke-muted"');
  });
```

In `apps/web/test/achievement-wall.test.ts` line 43, replace:

```ts
    expect(html).toContain('stroke="#4a4640"');
```

with:

```ts
    expect(html).toContain('class="stroke-rule-3"');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/raw-hex.test.ts test/achievement-badge.test.ts test/achievement-wall.test.ts`
Expected: FAIL. Both sources contain hex, and the badge renders no token classes.

- [ ] **Step 3: Implement**

`apps/web/app/components/achievement-badge.tsx`, replace lines 5-10:

```tsx
/** The shield every badge is drawn on (design hand-off 2026-09-12, 64×64 space). */
export const SHIELD = "M32 4l22 8v16c0 14-10 24-22 32C20 52 10 42 10 28V12z";
const LOCKED_FILL = "#0b0b0a";
const LOCKED_STROKE = "#2a2825";
const LOCKED_GLYPH = "#4a4640";
const PROGRESS_GLYPH = "#8a857c";
```

with:

```tsx
/** The shield every badge is drawn on (design hand-off 2026-09-12, 64×64 space). */
export const SHIELD = "M32 4l22 8v16c0 14-10 24-22 32C20 52 10 42 10 28V12z";
```

and replace the component (lines 37-55, from `export function AchievementBadge(` to its closing `}`):

```tsx
export function AchievementBadge({ achievementKey, group, state, pct, size = 56, className }: {
  /** `key` is React's own prop name, so the achievement's is spelled out. */
  achievementKey: AchievementKey; group: AchievementGroup; state: BadgeState; pct?: number; size?: number; className?: string;
}) {
  const colour = GROUP_COLORS[group];
  const unlocked = state === "unlocked";
  // ⚠️ Unlocked stays hex ATTRIBUTES: app/api/og/achievement/[key] draws this
  // component through next/og, which resolves no CSS, so a class there would
  // paint nothing — and the card only ever draws `unlocked`. Locked and
  // progress are site-only, so they take the palette's tokens as classes
  // instead of hex copies of them (L2): frame / rule-2 for the shield,
  // rule-3 for a locked glyph, muted for one in progress.
  const glyph = unlocked ? { stroke: colour } : { className: state === "progress" ? "stroke-muted" : "stroke-rule-3" };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" className={className}>
      {unlocked
        ? <path d={SHIELD} fill={tint(colour)} stroke={colour} strokeWidth="2" strokeLinejoin="miter" />
        : <path d={SHIELD} className="fill-frame stroke-rule-2" strokeWidth="2" strokeLinejoin="miter" />}
      {state === "progress" && (
        <path d={SHIELD} fill="none" stroke={colour} strokeWidth="2" strokeLinejoin="miter" strokeLinecap="square" pathLength={100} strokeDasharray={`${clampPct(pct)} 100`} />
      )}
      <g transform="translate(17 15) scale(1.25)">
        <path d={ACHIEVEMENT_GLYPHS[achievementKey]} fill="none" {...glyph} strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" />
      </g>
    </svg>
  );
}
```

The existing `pathLength="100"[^>]*stroke-dasharray` test still matches, because the ring path is unchanged. Note the visual change: the locked glyph goes from the off-palette `#4a4640` to rule-3 `#66625b`, one step lighter.

`apps/web/app/components/hero-map.tsx`, replace lines 47-90 (`Base` through `Mate`):

```tsx
/* ⚠️ Palette tokens as classes, never hex (L2): the glyphs are the map's own, and a hex copy of a token is a colour nothing holds to the palette. */
function Base({ className, size }: { className: string; size: number }) {
  return (
    <svg className={`absolute stroke-gold ${className}`} width={size} height={size} viewBox="0 0 28 28" fill="none" strokeWidth="2" strokeLinecap="square">
      <rect x="1" y="1" width="26" height="26" className="fill-frame stroke-frame" />
      <rect x="5" y="9" width="18" height="14" />
      <path d="M5 9l9-6 9 6M12 23v-7h4v7" />
    </svg>
  );
}

function Intruder({ className, label, size = 32 }: { className: string; label?: string; size?: number }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <span className="relative flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="absolute -inset-[5px] rotate-45 border-[3px] border-rust" />
        <svg width={size} height={size} viewBox="0 0 28 28"><circle cx="14" cy="14" r="9" className="fill-frame" /><circle cx="14" cy="14" r="5" className="fill-rust-2" /></svg>
      </span>
      {label && <span className={`${TAG} border-rust text-rust-2`}>{label}</span>}
    </div>
  );
}

function You({ className, label, size }: { className: string; label: string; size: number }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <svg className="stroke-gold" width={size} height={size} viewBox="0 0 28 28" fill="none" strokeWidth="2" strokeLinecap="square">
        <circle cx="14" cy="14" r="13" className="fill-frame stroke-frame" />
        <circle cx="14" cy="14" r="4" className="fill-gold" stroke="none" />
        <circle cx="14" cy="14" r="9" />
        <path d="M14 1v4M14 23v4M1 14h4M23 14h4" />
      </svg>
      <span className={`${TAG} border-rule-2 text-gold`}>{label}</span>
    </div>
  );
}

function Mate({ className, label }: { className: string; label: string }) {
  return (
    <div className={`absolute flex items-center gap-2 ${className}`}>
      <svg width={32} height={32} viewBox="0 0 28 28"><circle cx="14" cy="14" r="9" className="fill-frame" /><circle cx="14" cy="14" r="5" className="fill-ink" /></svg>
      <span className={`${TAG} border-rule-2 text-ink`}>{label}</span>
    </div>
  );
}
```

Regenerate the wall snapshots and read the diff:

Run: `cd apps/web && npx vitest run test/achievement-wall.test.ts -u && git diff test/__snapshots__/achievement-wall.test.ts.snap`
Expected: only the in-progress and locked tiles' badge `<path>` lines change, from `fill=`/`stroke=` hex attributes to `class="fill-frame stroke-rule-2"` / `class="stroke-rule-3"` / `class="stroke-muted"`. If Task 20 has already run, the `aria-label` removal also shows. The earned tile's badge does not change.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/raw-hex.test.ts test/achievement-badge.test.ts test/achievement-wall.test.ts test/achievement-share.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/hero-map.tsx apps/web/app/components/achievement-badge.tsx apps/web/test/achievement-badge.test.ts apps/web/test/achievement-wall.test.ts apps/web/test/__snapshots__/achievement-wall.test.ts.snap apps/web/test/raw-hex.test.ts
git commit -m "fix(web): draw the hero map and locked badges from palette tokens, not hex

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: The guide's anchors, pager and search work for touch and screen readers (L4, L7)

**Files:**
- Modify: `apps/web/app/guide/guide.css:19-23`
- Modify: `apps/web/app/guide/anchors.tsx:1-20`
- Modify: `apps/web/app/guide/chapter.tsx:48`
- Modify: `apps/web/app/guide/search.tsx:1-40`
- Test: `apps/web/test/guide-a11y.test.ts`

**Interfaces:**
- Produces: `resultsLine(q: string, n: number): string`, exported from `app/guide/search.tsx`, and `ANCHOR_COPIED = "Link copied"`, exported from `app/guide/anchors.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/guide-a11y.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChapterPage from "../app/guide/chapter";
import { Anchors, ANCHOR_COPIED } from "../app/guide/anchors";
import { GuideSearch, resultsLine } from "../app/guide/search";
import { CHAPTERS } from "../lib/guide";

describe("section anchors (L4)", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "guide", "guide.css"), "utf8");

  it("⚠️ are at full strength on a touch screen, which has no hover to reveal them", () => {
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.prose-guide h2 \.anchor\s*\{\s*opacity:\s*1;/u);
    expect(css).not.toMatch(/\.prose-guide h2 \.anchor\s*\{[^}]*opacity:\s*0;/u);
  });

  it("⚠️ announce the copy, instead of copying silently", () => {
    expect(ANCHOR_COPIED).toBe("Link copied");
    expect(renderToStaticMarkup(createElement(Anchors))).toMatch(/<p role="status" aria-live="polite" class="sr-only"><\/p>/u);
  });
});

describe("the chapter pager (L7)", () => {
  it("says Previous, not Back, for the previous chapter", () => {
    const html = renderToStaticMarkup(createElement(ChapterPage, { chapter: CHAPTERS[1]! }));
    // `&larr;` in JSX is the character itself by the time it is markup.
    expect(html).toContain("← Previous");
    expect(html).not.toContain("← Back<");
  });
});

describe("guide search (L7)", () => {
  it("⚠️ announces how many results appeared", () => {
    expect(resultsLine("a", 0)).toBe("");
    expect(resultsLine("raid", 0)).toBe("No results");
    expect(resultsLine("raid", 1)).toBe("1 result");
    expect(resultsLine("raid", 7)).toBe("7 results");
    expect(renderToStaticMarkup(createElement(GuideSearch, { index: [] }))).toMatch(/role="status" aria-live="polite" class="sr-only"/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/guide-a11y.test.ts`
Expected: FAIL. `ANCHOR_COPIED` and `resultsLine` are not exported, the CSS has `opacity: 0`, and the pager says "← Back".

- [ ] **Step 3: Implement**

`apps/web/app/guide/guide.css`, replace lines 19-23:

```css
.prose-guide h2 .anchor {
  margin-left: .5em; font-family: var(--font-mono); font-size: 14px; color: var(--color-dim); text-decoration: none; opacity: 0;
}
.prose-guide h2:hover .anchor, .prose-guide h2 .anchor:focus-visible { opacity: 1; }
.prose-guide h2 .anchor:hover { color: var(--color-gold); }
```

with:

```css
/* The section anchor: faint until its heading is hovered or it is focused. */
.prose-guide h2 .anchor {
  margin-left: .5em; font-family: var(--font-mono); font-size: 14px; color: var(--color-dim); text-decoration: none; opacity: .45;
}
.prose-guide h2:hover .anchor, .prose-guide h2 .anchor:focus-visible { opacity: 1; }
.prose-guide h2 .anchor:hover { color: var(--color-gold); }
/* ⚠️ A touch screen has no hover: there the anchor is at full strength, or it is never found (L4). */
@media (hover: none) {
  .prose-guide h2 .anchor { opacity: 1; }
}
```

`apps/web/app/guide/anchors.tsx`, replace the whole file:

```tsx
"use client";
import { useEffect, useState } from "react";

/** What the live region says after a copy. */
export const ANCHOR_COPIED = "Link copied";

/**
 * Copies a section's URL when its `#` anchor is clicked. Progressive: the
 * anchor is a real link to the id, so without this the hash still changes
 * and the address bar still shows the link — this just saves the copy.
 *
 * ⚠️ The copy is ANNOUNCED through a polite live region (L4). A silent copy
 * leaves a screen-reader user, and anyone else, guessing whether it happened.
 * The region is cleared first so a second copy is announced again.
 */
export function Anchors() {
  const [said, setSaid] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest?.("a.anchor") as HTMLAnchorElement | null;
      if (!a || !navigator.clipboard) return;
      navigator.clipboard.writeText(a.href).then(() => {
        setSaid("");
        clearTimeout(timer);
        timer = setTimeout(() => setSaid(ANCHOR_COPIED), 50);
      }, () => { /* the hash still changes */ });
    };
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("click", onClick); clearTimeout(timer); };
  }, []);
  return <p role="status" aria-live="polite" className="sr-only">{said}</p>;
}
```

`apps/web/app/guide/chapter.tsx:48`, replace:

```tsx
            <span className="block font-mono text-[11px] uppercase tracking-[0.18em] text-muted">&larr; Back</span>
```

with:

```tsx
            {/* "Previous", not "Back": this is the previous CHAPTER, not the page you came from (L7). */}
            <span className="block font-mono text-[11px] uppercase tracking-[0.18em] text-muted">&larr; Previous</span>
```

`apps/web/app/guide/search.tsx`, replace the whole file:

```tsx
"use client";
import { useMemo, useState } from "react";
import type { SearchEntry } from "./index";

/** What the live region says for a query `q` with `n` hits: nothing until the search starts (two characters). */
export function resultsLine(q: string, n: number): string {
  if (q.trim().length < 2) return "";
  if (n === 0) return "No results";
  return n === 1 ? "1 result" : `${n} results`;
}

/**
 * A guide search box: substring match over chapter, heading and hint text,
 * in the browser, over the index the layout built. Two characters to start,
 * twelve results at most, Escape clears.
 *
 * ⚠️ The count is announced through a polite live region (L7): results
 * appear under the box as you type, and without it a screen reader hears
 * nothing happen.
 */
export function GuideSearch({ index, compact = false }: { index: SearchEntry[]; compact?: boolean }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    return index.filter((e) => `${e.chapter} ${e.heading ?? ""} ${e.text} ${e.body ?? ""}`.toLowerCase().includes(needle)).slice(0, 12);
  }, [q, index]);

  return (
    <div className="relative">
      <input
        type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
        placeholder="Search the guide" aria-label="Search the guide" autoComplete="off" spellCheck={false}
        className="block min-h-[44px] w-full border-2 border-rule-3 bg-ground px-3 font-mono text-[13px] text-ink placeholder:text-muted focus:border-gold focus:outline-none"
      />
      <p role="status" aria-live="polite" className="sr-only">{resultsLine(q, hits.length)}</p>
      {q.trim().length >= 2 && (
        <ol className="m-0 mt-2 list-none border-2 border-rule-2 bg-frame p-0" aria-label="Results">
          {hits.length === 0 && <li className="px-3 py-2.5 text-sm text-ink-2">Nothing in the guide says that.</li>}
          {hits.map((h) => (
            <li key={h.href} className="border-t border-rule-2 first:border-t-0">
              <a href={h.href} className="block px-3 py-2.5 no-underline hover:bg-surface">
                <span className="block font-display text-[13px] text-ink">{h.number}. {h.chapter}{h.heading && <span className="text-gold"> › {h.heading}</span>}</span>
                {h.text && <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{h.text}</span>}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

The `compact` prop is kept in the signature. It was unused before, and the drawer still passes it.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/guide-a11y.test.ts test/guide.test.ts test/table-semantics.test.ts && npx tsc --noEmit`
Expected: PASS. The `guide.css` "prose only" test still holds, because the `@media` line starts with `@` and the inner rule is indented.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/guide/guide.css apps/web/app/guide/anchors.tsx apps/web/app/guide/chapter.tsx apps/web/app/guide/search.tsx apps/web/test/guide-a11y.test.ts
git commit -m "fix(web): visible guide anchors on touch, announced copies and search counts, Previous not Back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Achievement tiles drop the aria-label their text already says (L8)

**Files:**
- Modify: `apps/web/app/components/achievement-wall.tsx:35-37`
- Modify: `apps/web/test/achievement-wall.test.ts:47-51`
- Update: `apps/web/test/__snapshots__/achievement-wall.test.ts.snap` (regenerated)

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

In `apps/web/test/achievement-wall.test.ts`, replace the test `"keeps the accessible name with the state in it"`:

```ts
  it("keeps the accessible name with the state in it", () => {
    expect(render(tile({}))).toContain('aria-label="Ten Down: 3 / 10"');
    expect(render(tile({ key: "first_blood", target: 1, count: 0 }))).toContain('aria-label="Ten Down: Locked"');
    expect(render(tile({ earnedAt: new Date("2026-09-10T12:00:00Z"), count: 10 }))).toContain('aria-label="Ten Down: Earned 10 Sept"');
  });
```

with:

```ts
  /**
   * L8: an aria-label on an <li> is honoured by some screen readers and not
   * others, and here it only restated the tile's own visible text. The state
   * is in words in the tile (earned line, progress, "Locked"), so that is the
   * one statement, for everyone.
   */
  it("says the state in visible words, with no aria-label on the tile", () => {
    const tiles = [render(tile({})), render(tile({ key: "first_blood", target: 1, count: 0 })), render(tile({ earnedAt: new Date("2026-09-10T12:00:00Z"), count: 10 }))];
    for (const html of tiles) expect(html).not.toMatch(/<li[^>]*aria-label=/u);
    expect(tiles[0]).toContain(">3 / 10<");
    expect(tiles[1]).toContain(">Locked<");
    expect(tiles[2]).toMatch(/>Earned 10 Sept?</u);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/achievement-wall.test.ts`
Expected: FAIL. The `<li>` still has `aria-label`.

- [ ] **Step 3: Implement**

`apps/web/app/components/achievement-wall.tsx`, replace lines 35-37:

```tsx
    // ⚠️ The accessible name carries the state, not just the name: earned says
    // when, in-progress says how far, and a one-shot says it is locked.
    <li className={`flex items-center gap-3 border-2 px-3 py-2.5 ${earned ? `${tone.border} ${tone.bg}` : "border-rule-2 bg-surface"}`} aria-label={`${t.name}: ${earned ? earnedLine(t) : progress ?? WALL.locked}`}>
```

with:

```tsx
    // ⚠️ The state is said in the tile's own visible WORDS (the earned line,
    // the progress count, "Locked") — never only in colour, and not in an
    // aria-label on the <li>, which some screen readers ignore and which only
    // restated this text (L8).
    <li className={`flex items-center gap-3 border-2 px-3 py-2.5 ${earned ? `${tone.border} ${tone.bg}` : "border-rule-2 bg-surface"}`}>
```

Regenerate the snapshots and read the diff:

Run: `cd apps/web && npx vitest run test/achievement-wall.test.ts -u && git diff test/__snapshots__/achievement-wall.test.ts.snap`
Expected: each tile snapshot loses exactly its ` aria-label="…"` attribute, and nothing else changes.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/achievement-wall.test.ts test/achievements-surfaces.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/achievement-wall.tsx apps/web/test/achievement-wall.test.ts apps/web/test/__snapshots__/achievement-wall.test.ts.snap
git commit -m "fix(web): drop the achievement tile's redundant aria-label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Changelog entry and the full gate

**Files:**
- Modify: `CHANGELOG.md:6` (under `## [Unreleased]`)

**Interfaces:** none.

- [ ] **Step 1: Write the entry**

In `CHANGELOG.md`, directly under `## [Unreleased]` (line 6), insert:

```markdown

### Fixed

- On a phone, the notifications panel and the guide's Contents no longer open partly off
  the left edge of the screen, and only one of Menu, notifications and Contents can be
  open at a time.
- The season picker wraps onto a second row instead of running off a phone screen once
  there are three or more seasons.
- Flag lists load small thumbnails instead of full-size flags, and phones no longer
  download the landing page's flag pool, which they never showed.
- Small labels are easier to read: nothing meaningful is smaller than 11px, and the
  guide's "Enforced by people" label and the season numbers on /alphas and /seasons
  are no longer near-invisible.
- The server-name banner stops scrolling after two passes, and pauses when tapped or
  focused.
- The Guide stays in the top bar on screens 1024–1279px wide.
- Screen readers: the standings and every-number tables name their columns, the war
  log's days are headings, every "See all" and "All" link says where it goes, the
  landing scoreboard's numbers say what they count, the guide announces search results
  and copied links, and the achievement tiles no longer repeat themselves.
- Times in the war log and player feeds say UTC, and an award's deadlines no longer
  change on screen after the page loads.
- Clan and player pages show the clan's or player's name in the browser tab.
- On a phone, /scoreboard shows each clan's full name and tag with its raids,
  times raided and defenses underneath, and long clan names on /clans wrap instead
  of pushing the member count off the screen.
- The award page has the site's heading, a link back to your awards, and empty slots
  you can see.
- The install banner's close button, the 404 page's links and the account links on
  your page are full-size touch targets.
- Number columns line up.
```

- [ ] **Step 2: Run the full gate from the repo root**

Run:

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: `Tasks: 30 successful, 30 total`. Check the count, not the exit code, because a cached pass proves nothing. Do not start a second gate or a package `vitest` while this runs, since the runs share `factions_test_<package>`.

- [ ] **Step 3: Fix anything the gate finds**

If a task outside `@factions/web` fails, confirm it also fails on `main` before touching it. None of this plan's changes leave `apps/web`, so a failure elsewhere is pre-existing or a shared-database collision (see CLAUDE.md). If `@factions/web` fails, fix it in the task whose test owns the failing file, and re-run Step 2 until it reports 30/30.

- [ ] **Step 4: Confirm nothing uncommitted is left**

Run: `git status --short`
Expected: only `CHANGELOG.md` modified.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): shell and public pages UX fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

| Finding | Task | Test that pins it |
|---|---|---|
| H1 bell / Contents off-screen; three popovers open at once | 1 | `test/popover.test.ts` |
| H2 season picker overflow | 2 | `test/seg-nav.test.ts` |
| H3 "Enforced by people" rust text at 10px | 5 | `test/text-floor.test.ts` |
| H4 "S1" at 1.34:1 | 5 | `test/text-floor.test.ts` |
| H5 1.7MB of flags; landing pool fetched on phones; no lazy loading | 3, 4 | `test/flag-thumbs.test.ts`, `test/wide-only.test.ts` |
| M1 marquee never stops | 6 | `test/server-strip.test.ts` |
| M2 Guide unreachable at 1024–1279 | 7 | `test/menu.test.ts` |
| M3 tables without scope / caption / thead | 8 | `test/table-semantics.test.ts` |
| M4 war-log days not headings or lists | 9 | `test/war-log-days.test.ts` |
| M5 unlabelled UTC; award hydration mismatch | 10 | `test/utc-times.test.ts`, `test/award-render.test.tsx` |
| M6 generic clan and player titles | 11 | `test/page-titles.test.ts` |
| M7 9–10px text (timer bar, award slots, guide labels, bell rows) | 5 | `test/text-floor.test.ts` |
| M8 install close ~8×44px | 12 | `test/touch-targets.test.ts` |
| M9 indistinguishable "See all" / "All →" | 14 | `test/link-names.test.ts` |
| M10 landing scoreboard's bare numbers | 14 | `test/link-names.test.ts` |
| M11 long clan names overflow /clans | 15 | `test/clan-rows.test.ts` |
| M12 award page: no BackLine, hand-built head, rule-2 slot edge | 16 | `test/award-render.test.tsx` |
| L1 no tabular-nums | 17 (and 13/14/15 for the new rows) | `test/tabular-nums.test.ts`, `test/score-rows.test.ts` |
| L2 raw hex | 18 | `test/raw-hex.test.ts`, `test/achievement-badge.test.ts` |
| L3 hard-coded bar offsets | 1 | `test/popover.test.ts` |
| L4 anchors invisible on touch, silent copy | 19 | `test/guide-a11y.test.ts` |
| L5 root 404 links under 44px | 12 | `test/touch-targets.test.ts` |
| L6 owner button spacing; 3-column links at 375px | 12 | `test/touch-targets.test.ts` |
| L7 pager "Back"; search not announced | 19 | `test/guide-a11y.test.ts` |
| L8 aria-label on `<li>` | 20 | `test/achievement-wall.test.ts` |
| S1 /scoreboard phone names truncated, header wraps, tag hidden | 13 | `test/score-rows.test.ts` |

Review Focus coverage: (1) 32-character names are tested in Tasks 13 and 15. (2) Season 5 is tested in Task 2. (3) Two popovers are tested in Task 1. (4) A missing thumbnail is tested in Task 3. (5) The award time zone is tested in Task 10.

Deliberate deviations from the finding text:
- H5 generates one thumbnail size, 96px on the long edge, instead of 48 and 80. Lists draw a flag at most 48 CSS px wide, so 96 covers a 2x screen, and one size keeps one script, one constant and one test.
- M6 uses the site's existing title form, "Clan Wars — <name>", which `test/kit.test.ts` pins as the house format, instead of putting the name first.
- M7's bell-panel rows live in `notice-row.tsx`, which the notifications page shares. Only the type size changes there. That page's layout and its rust usage stay with the FORMS plan.

---

## Appendix: findings

# Shell & public pages UX findings (2026-09-24 review). Paths relative to apps/web.

Token contrast (fine): ink 15.3:1 on frame, ink-2 9.0, muted 5.4, dim 4.9, gold 8.5, rust-2 5.3, olive 7.1. Failures come from rust / rule-2 / rule-3 used as TEXT.

## High
H1. Bell panel and guide Contents panel open partly off the left edge on phones. CONFIRMED LIVE at 375px: bell panel's left ~55px clipped (heading "Notifications" and row starts cut off). components/notifications-bell.tsx:38 `absolute right-0 … w-[340px]` against its <details>; bell sits left of Menu (site-bar.tsx:39-42). Same in guide/layout.tsx:48 `absolute right-0 … w-[min(86vw,320px)]` (~35px off signed out, ~98px signed in). These panels + the Menu drawer are three independent <details>, can all be open at once at z-1300. Fix: below lg, `fixed inset-x-3 top-[calc(var(--spacing-bar)+8px)]`; opening one closes the others (Drawer already has Escape/click-outside handler to copy).
H2. Season picker will overflow phones from Season 3: components/ui.tsx:166-169 SegNav items `flex-1 whitespace-nowrap px-3`, no wrap/scroll. ScopePicker (stat-boards.tsx:8-17) adds one item per season; All-time + S1–S3 ≈ 384px vs ~335px. Appears on /players, every /players/[gamertag] (ClanHero aside), every /players/boards/[board]. Fix: overflow-x-auto with flex-none items on phones, or <select> on phones.
H3. Guide "Enforced by people" label is rust text 2.57:1 at 10px: guide/guide.css:51 `.human::before { font-size:10px; color: var(--color-rust) }`. Fix: rust-2, ≥11px.
H4. Season number "S1" at 1.34:1 — alphas/page.tsx:52 and seasons/page.tsx:29 `text-rule-2`; on /alphas it's the only place the season number appears. Fix: text-dim/muted, or aria-hidden decoration + real "Season N" text.
H5. Flags: 33 PNGs in public/flags, 256×128, ~50KB each (1.7MB), shown at 24–40px. Landing Flag pool panel is `hidden lg:block` ((site)/page.tsx:115-118) but browsers still fetch — phones download 1.7MB never shown. /clans loads all 33 again (clans/page.tsx:55-56). No loading="lazy" anywhere. Fix: generate small WebP thumbnails (48/80px) for list use (sharp is a devDependency; follow existing item-images/flag pipeline & tests), loading="lazy" on pool/list flags, don't render landing pool on phones (not CSS-hide).

## Medium
M1. Server-name marquee (globals.css:71-72) loops forever, pauses only on :hover — WCAG 2.2.2 fails for keyboard/touch. Reduced motion handled well. Fix: pause button / :focus-within pause / stop after one pass.
M2. Guide unreachable from nav at 1024–1279px: lib/menu.ts:67 Guide is `quiet`, menu-list.tsx:33 hides quiet below xl (`!hidden xl:!flex`); phone drawer is lg:hidden (site-bar.tsx:39); Footer only on / and owner's own player page. Comment at menu.ts:20 claims it "stays in the drawer and the footer" — false at that width. Fix: keep Guide visible from lg (e.g. overflow item or shorter labels when signed in).
M3. Tables lack scope/caption: scoreboard/page.tsx:30-40, seasons/page.tsx:38-47 `<th>` no scope="col", no <caption>; scoreboard Panel has no title → table unnamed. guide/chapter.tsx:70-91 appendix table has no <thead>; group rows are <td colSpan={2}> styled as headers. Fix: scope="col", sr-only caption, group rows <th scope="rowgroup" colSpan={2}>, sr-only header row "Rule | Value".
M4. War log day groups not headings/lists: war-log/page.tsx:62-86 day heading is a styled <div>, entries <div>s. Fix: <h2> per day + <ul>/<li>.
M5. Times: when() adds " UTC" (packages/copy/src/format.ts:12); player-feed.tsx:7 (stamp) and war-log/entry.tsx:34 (WarLogKicker, used on landing + clan pages) format UTC without the label. awards/[id]/award-flow.tsx:14 uses toLocaleString(undefined,…) (local) in a client component also server-rendered → hydration text mismatch. Fix: when() everywhere or add UTC; award page format on server or after mount.
M6. Every clan page title "Clan Wars — clan" (clans/[tag]/page.tsx:17), every player "Clan Wars — player" (players/[gamertag]/page.tsx:23). Fix: generateMetadata `${clan.name} [${tag}] — Clan Wars`, as players/boards/[board]/page.tsx:14 already does.
M7. Real info at 9–10px: timer-bar.tsx:15 KICKER text-[10px] on phones, used for Raid/Restart labels and c.detail (:48, skip reason). award-flow.tsx:125 slot labels text-[9px]. guide.css:39,46 Promise/log labels 10px. Also live: the notifications bell panel's row text (kind label "Ban"/"Award", "(Unread)", age "21h") is 10px. Fix: 11px floor.
M8. Install strip close ✕ (install-strip.tsx:72) `flex min-h-[44px] items-center` no horizontal padding → ~8×44px; glyph as icon. Fix: min-w-[44px] justify-center, or "Not now" text.
M9. Ten "See all" links on /players (stat-boards.tsx:61); "All →" on landing and clan page ((site)/page.tsx:101, clans/[tag]/page.tsx:113) — indistinguishable in SR link list. Fix: sr-only suffix with board/panel name.
M10. Landing scoreboard shows points/raids/defenses as bare numbers, no header/unit ((site)/page.tsx:92-94). CONFIRMED LIVE (desktop: "400 2 1"). Fix: small header row as /scoreboard has, or sr-only labels.
M11. Long clan names may overflow /clans rows on phones: clans/page.tsx:36,70 name span in flex row with no min-w-0/truncate/overflow-wrap; CLAN_NAME_LENGTH.max 32 in Archivo Black 15px ≈ 350px. Landing and /scoreboard use truncate. Fix: min-w-0 truncate or [overflow-wrap:anywhere].
M12. Award page (awards/[id]/award-flow.tsx) has no BackLine to /awards or player page; hand-builds head instead of PageHead; empty slot buttons `border-dashed border-rule-2` (:124, 1.34:1) vs house rule control edge = rule-3. Fix: BackLine, rule-3.

## Low
L1. No tabular-nums on number columns: stat-boards.tsx:47, scoreboard/page.tsx:15,56, seasons/page.tsx:15,60. Add to `num` and board value span.
L2. Raw hex: hero-map.tsx:49-86 (#d9a03c,#0b0b0a,#d4623a,#e8e2d4 in SVG); achievement-badge.tsx:7-10 #4a4640 (not a token). Use var(--color-*) / currentColor.
L3. Hard-coded offsets: menu-list.tsx:81 top-[60px], notifications-bell.tsx:38 top-[54px] instead of --spacing-bar.
L4. Guide section anchor (guide.css:20-22) opacity 0 until hover/focus → touch never sees it; anchors.tsx:14 copies URL silently. Fix: faint always; announce "Link copied" via polite live region.
L5. Root 404 (app/not-found.tsx) outside (site): no site bar; its two links 11px without 44px min. Fix: inline-flex min-h-[44px], or render SiteBar.
L6. owner.tsx:158,178 btnPrimary link directly under paragraph with no mt-3; owner.tsx:214-218 grid-cols-3 at 375px wraps "Browse the clans →" to 3 lines → grid-cols-1 sm:grid-cols-3.
L7. guide/chapter.tsx:48 pager "← Back" means previous chapter → "Previous". guide/search.tsx:25-36 results appear with no live announcement → sr-only aria-live count.
L8. achievement-wall.tsx:37 aria-label on <li> (inconsistently handled; visible text already carries state :42-48) → drop it.

## NEW (confirmed live)
S1. /scoreboard at 375px: clan names truncate to "Dead R…", "The Ad…", "The Co…" while the "R / RD / D" stats column has spare room, and its header wraps onto two lines ("R / RD /" then "D"). Clan tag hidden on phones. Fix phone layout so names get room (e.g. stats as a second line under the name, or a narrower stat column) and the header never wraps.

## Working well (keep)
Tokens defined once with documented contrast; skip link + focusable <main>; gold focus rings; bell announces unread count in words; primitives meet 44px; SegNav/BarNav/Contents use aria-current; timer bar deliberately not a live region; reduced-motion for marquee/kit; dvh; next/font self-hosted with display swap; hero image sized with fetchPriority high.
