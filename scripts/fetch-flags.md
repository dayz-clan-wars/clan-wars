# Fetch and normalise the flag images

Downloads the 33 claimable flag textures' images from the DayZ Fandom wiki via its
MediaWiki API, resizes each to 256px on the long edge, and writes them into
`apps/web/public/flags/` as PNGs. Those files are what the bot's Discord embeds and the
`dayzclanwars.com` site use as flag thumbnails.

**Hand-run only. Never part of a build or deploy.** A plain `GET` of the wiki's HTML
pages returns 403 — the script uses the MediaWiki API at `dayz.fandom.com/api.php`
instead, which answers normally, but a build step that reaches out to a third-party wiki
is still a build that fails the day that wiki blocks CI's IP range, rate-limits it, or is
simply down. It is also a build whose output could change with nothing in this
repository changing, which is not a property a deploy pipeline should have.

**Its output is committed.** `apps/web/public/flags/*.png` (33 files) are checked into
git, not generated at deploy time. A drift test
(`apps/web/test/flag-assets.test.ts`) holds the committed directory and
`CLAIMABLE_FLAGS` together — it fails if the two ever disagree.

## When to run it

The flag pool is fixed at 33 by design (`packages/domain/src/flags.ts`), so the expected
frequency of running this is: once. Re-run it only if a flag image needs to be
re-fetched or re-normalised — for example after `MAX_EDGE` changes, or after a
`WIKI_FILENAME_ALIASES` fix (see below).

## Run

```bash
pnpm --filter @factions/web exec tsx scripts/fetch-flags.ts
```

Prints one line per flag — texture, wiki filename, source bytes, output bytes — then
`wrote 33 flag image(s) to public/flags/`. Then run the drift test:

```bash
pnpm --filter @factions/web test -- flag-assets
```

## If a flag 404s

Do **not** skip it, comment it out, or relax the drift test. A missing flag means one of
two things:

- **The wiki renamed the file.** Add a second entry to `WIKI_FILENAME_ALIASES` in
  `apps/web/src/flag-images.ts` (it already carries one, for `Flag_Sakhal`) and update
  its test in `apps/web/test/flag-images.test.ts` to match.
- **`CLAIMABLE_FLAGS` and the wiki have genuinely diverged** — a texture that exists in
  the game pool has no corresponding wiki page. That is a finding to report, not a thing
  to route around.

## If you re-run this and a filename doesn't change

`deploy/nginx/dayzclanwars.com.conf`'s `location /flags/` block serves `/flags/*` with
`Cache-Control: public, max-age=604800, immutable` — 7 days. That's fine for a file that
never changes, but if you regenerate an image under the **same filename** with
**different bytes** (a re-fetch after the wiki updated its source art, a `MAX_EDGE`
change re-encoding the same texture), any browser that already cached the old bytes is
stuck with them for up to a week — there's no content hash, query param, or versioned
path in the URL to bust it. Discord caches thumbnails against its own CDN regardless of
what nginx sends, so this is a browser-only concern, not a Discord one.

If that matters for a given change, the recovery is either a cache-busting query string
on the URL where it's referenced, or a change to that block's cache policy for
`/flags/*` — not something this script or the drift test can do for you. That policy is
TWO directives working as a pair: `proxy_hide_header Cache-Control` strips Next.js's own
`Cache-Control: public, max-age=0` on these files, and `add_header Cache-Control
"public, max-age=604800, immutable"` sets ours. Changing the `add_header` value alone,
without the `proxy_hide_header`, silently reintroduces both headers on the response —
per RFC 9110 they concatenate and the upstream `max-age=0` wins, so the change looks
right in the config and in a diff but caches nothing.
