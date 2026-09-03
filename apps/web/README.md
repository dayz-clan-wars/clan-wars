# @factions/web

The `dayzclanwars.com` website. Today it is one static page and the 33 flag
images the bot's Discord embeds use as thumbnails — nothing else.

## What this is today

A Next.js 16 (App Router) app with a single statically rendered route, `/`:
the project name and a short statement of what Clan Wars is. No email
capture, no countdown, no faction data.

No Discord link yet — deliberately deferred, because we don't have an invite
URL and a fabricated or placeholder one on a public page is worse than no
link. `apps/web/app/globals.css` already styles `a` for when it lands.

**It reads no database.** `factions_live` is on a different machine from the
VPS this app deploys to, so a data-driven page is not merely unspecced — it
is currently unreachable. `apps/web/test/smoke.test.ts` pins the structural
half of that as an invariant: the app imports no database package and reads
no `DATABASE_URL`. That's also what makes the app deployable at all — a
database import here would fail in production rather than being caught at
review.

Nothing on this site may create a faction, claim a flag, bind a pole, or
alter a roster. The site renders history; it does not write it. See
CLAUDE.md's "The website is a surface, never a source of truth" invariant.

Everything else — a faction map, roster management, a public directory,
authentication — is deliberately out of scope. See
`docs/direction/2026-09-02-web-app-and-faction-map.md` for what's open, and
`docs/superpowers/specs/2026-09-03-web-app-skeleton-design.md` for why this
skeleton stops where it does.

## Running locally

```bash
pnpm --filter @factions/web dev
```

`pnpm --filter @factions/web build` produces `next-env.d.ts`, which is
gitignored and required for `tsc --noEmit` to pass — run it once after a
fresh clone if typecheck fails for that reason.

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
