# @factions/web

The `dayzclanwars.com` website: the landing page, the gated `/me`, and the 33
flag images the bot's Discord embeds use as thumbnails.

## What this is today

A Next.js 16 (App Router) app on Tailwind v4. Public: the landing page, and
`/guide` — the field guide, rendered from hand-written HTML fragments in
`content/guide/` (`lib/guide.ts` is the chapter manifest). `app/guide/render.ts`
substitutes `{{KEY|format}}` number tokens from `@factions/domain`'s
`guide-numbers.ts` and anchors every heading; `app/guide/index.ts` builds the
search index from the same pass; `lib/guide-links.ts` is where each page's
"In the guide" link points.

Every other page sits in the `app/(site)/` route group, whose layout reads the
session and renders the top bar and menu (`site-bar.tsx`, `menu-list.tsx`;
`lib/menu.ts` is the menu's contents, pinned by `test/menu.test.ts`). Gated
behind Discord login and guild membership (`lib/auth`, `middleware.ts`): `/me`,
which shows the viewer's link and clan, read through `@factions/roster`. Since
2026-09-09 `/me` is a route handler, not a page: it forwards a linked member to
their own public player page and an unlinked one to `/link` (`lib/own-page.ts`).
The player page renders the owner's controls — next step, invites, requests,
unlink, sign out (`app/components/owner.tsx`) — only when the session's linked
gamertag is the page's.

Since increment 2b, also gated: `/link` (start or cancel a challenge, unclaimed
gamertag autocomplete, a 5 s status poll) and `/base` (declare or release a solo
base at a pole the viewer raised at); `/me` gained an unlink form. Their API
handlers are `/api/link/search`, `/api/link/start`, `/api/link/cancel`,
`/api/link/status`, `/api/link/unlink`, `/api/base/declare` and
`/api/base/release`. Every page that reads the viewer is `force-dynamic`; every
personal JSON response is `Cache-Control: no-store, private`.

**It imports no database package.** `packages/roster` owns the client and
exports only the operations the site is allowed to perform — see the target-
state spec §10.4 and the frontend rebuild spec §2–§3 for the boundary and why
it is a package rather than an HTTP service. `apps/web/test/smoke.test.ts`
pins both halves: the app imports no `@factions/db`, and `@factions/roster`
exports exactly its allowlist.

Rituals are earned in game; administration is not a ritual. The site will
never create a clan, claim a flag or bind a pole. Roster chores land here in
later increments.

## Running locally

```bash
pnpm --filter @factions/web dev
```

`pnpm --filter @factions/web build` produces `next-env.d.ts`, which is
gitignored and required for `tsc --noEmit` to pass — run it once after a
fresh clone if typecheck fails for that reason.

`/me` needs `DATABASE_URL` in the environment — an `.env.local` in
`apps/web` works; point it at the local `factions` database, never
`factions_live`. Without it, `packages/roster` throws by design on the
first `/me` request.

## The flag images

`apps/web/public/flags/*.png` — 33 files, one per texture in
`packages/domain/src/flags.ts`'s `CLAIMABLE_FLAGS` — are committed static
assets, not generated at build or deploy time. They are fetched and
normalized by a hand-run script; see `scripts/fetch-flags.md` for how it
works, when to re-run it, and what to do if a flag 404s. Don't duplicate that
content here — that file is the source of truth for the fetch process.

A drift test, `apps/web/test/flag-assets.test.ts`, holds `CLAIMABLE_FLAGS`
and the committed directory together: it fails if a flag has no image or an
image has no flag.

## Where the images came from, and why that's a judgment call

These are Bohemia Interactive's game assets, mirrored on the DayZ Fandom
wiki. We serve them to identify those same in-game items, for a private
community server for that game, non-commercially. That's ordinary practice
for game community sites and the practical risk is low — but it is not a
settled legal right, and nobody qualified has reviewed it. Recorded here as a
judgment that was made, rather than left implied. If it ever needs undoing,
the images are 33 files in one directory, and the bot's resolver already
falls back to `null` — the state the feed ran in before these existed.
