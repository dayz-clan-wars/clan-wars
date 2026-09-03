# dayzclanwars.com — the web app skeleton — design

**Date:** 2026-09-03
**Covers:** the deployable shell for `docs/direction/2026-09-02-web-app-and-faction-map.md`,
and the flag artwork that inbox item 35 has been waiting for
**Builds on:** the faction feed (deployed 2026-09-03) — `feed-embed.ts`'s resolver hook
exists precisely so this can fill it
**Blocks:** nothing. Everything in the direction note stays open.

---

## 1. Purpose

Two things, and they are related more closely than they look.

**A place to stand.** The direction note wants Discord reduced to announcements and every
player tool moved to a website — a faction map, roster management, the public directory.
None of that can be specced usefully while there is no site, no domain, no deployment and
no answer to "where does it run". This builds the shell and nothing else, so that the
first real feature is a feature rather than a feature plus an infrastructure project.

**Somewhere to serve the flags.** The faction feed posts embeds with no thumbnail because
none of the 33 flag textures has an image anywhere in this repository, and Discord embed
thumbnails need a publicly reachable URL. A site at `dayzclanwars.com` is that URL. This
is why the skeleton is worth building before any feature needs it: it is already useful
the day it deploys.

### In scope

- `apps/web`, a Next.js app in the existing pnpm workspace
- One statically rendered page at `/`
- The 33 flag images, fetched once, normalized, committed, served as static files
- `FLAG_IMAGE_BASE_URL` in the bot, filling `feed-embed.ts`'s existing resolver hook
- A Dockerfile, two compose services (`web`, `caddy`), and a deploy runbook

### Out of scope, deliberately

- **Discord OAuth, sessions, any authentication.** The direction note flags session
  security as "a real surface for the first time" — a logged-in session that shows base
  coordinates is a new class of thing to get wrong. It gets its own design.
- **Any database access.** `factions_live` is on a different machine from the VPS
  (§5), so a data-driven page is not merely unspecced, it is currently unreachable.
- **The faction map, the roster, the public directory, an API.** Every open question in
  the direction note stays open.

---

## 2. `apps/web`

An eleventh workspace package, `@factions/web`. There are three apps and seven packages
today — ten, times the two turbo tasks, is where the 20-task gate comes from. It matches
the shape of the three existing apps: `typecheck` and `test` scripts, so turbo discovers
it without configuration.

⚠️ **The gate becomes 22 tasks, not 20.** CLAUDE.md states "Expect 20/20 tasks" and tells
readers to check the count rather than the exit code — so that number is load-bearing
instructions, and it stops being true the moment this package exists. It is updated in the
same change.

Next.js 16 (App Router), TypeScript, no UI framework or component library. The dependency
is deliberately minimal: this app renders one page today, and every library added now is
one chosen before the thing that would justify it exists.

`output: "standalone"` in the Next config, for the Docker image in §5.

---

## 3. The page

One route, `/`, statically rendered: the project name, a short statement of what Clan Wars
is, and a link to the Discord. No email capture, no countdown, no faction data.

It reads nothing. That is what makes it deployable today while the database sits on
another machine, and it is why this design can ship without answering any of the direction
note's questions.

### ⚠️ The site is a surface, never a source of truth

The project's thesis is that faction state is earned by things players do in the world and
proved from the game server's own logs. Nothing on this site may create a faction, claim a
flag, bind a pole, or alter a roster. The site renders history; it does not write it.

Stated here, while the site does nothing at all, because it is far harder to introduce
this rule after something on the site already wants to write.

---

## 4. Flag images

### Where they come from

The Fandom wiki at `dayz.fandom.com`. Direct page scraping is blocked — a plain
`GET /wiki/Flag` returns **403** — but the MediaWiki API answers normally:

    https://dayz.fandom.com/api.php?action=parse&page=Flag&prop=images&format=json

⚠️ **The wiki hosts two different galleries of the same flags, and an earlier version of
this page used the wrong one.** One gallery is hanging/folded flag renders — portrait,
around 877×1027, ratio ~0.85 — the kind of image you'd put on a wiki infobox. The other is
the flat, in-game `_co` textures themselves — landscape, mostly exactly 512×256. We want
the second: it is what the game actually renders on a pole, and it is what a Discord embed
thumbnail should show. The first 33-image mapping this repo committed was built from the
portrait gallery; it looked fine in isolation and was wrong. Corrected 2026-09-03.

### ⚠️ Essentially nothing maps by rule — the mapping is a complete 33-entry table

The flat gallery names files after the abbreviation baked into each `_co` texture, not
after our `Flag_X` names: `Flag_Wolf` is `Flag_wolf_co.png`, `Flag_Rooster` is
`Flag_cock_co.png`, `Flag_Bohemia` (Bohemia Interactive) is `Flag_bi_co.png`, and so on.
There is no transform from `Flag_X` to the wiki's name general enough to be worth writing —
it would have to already know the in-game abbreviation, at which point it isn't a rule, it
*is* the table. So `WIKI_FILENAME` in `apps/web/src/flag-images.ts` is 33 explicit entries,
one per claimable texture, each verified against the MediaWiki API on 2026-09-03.

**Two textures have no `_co` game texture on the wiki at all: `Flag_Chedaki` and
`Flag_Sakhal`.** Both fall back to whatever flat image the wiki does have, and both are
lower quality than the rest — `Flagchedaki1.jpg` is 360×234 and a JPEG, `Sakhalflag.PNG`
is 475×249 — but both are still landscape and still the right *kind* of image. Do not
"fix" these to invented `_co` names; none exist. And `Flag_Sakhal` maps to `Sakhalflag.PNG`
— no underscore — not `Sakhal_flag.PNG` — with one — which is a different file: the
portrait folded render from the gallery we are no longer using.

A texture not in `WIKI_FILENAME` throws, naming the texture, rather than guessing
`<texture>.png` — a miss means the flag pool and this table have diverged, and that must be
loud rather than a silently-broken embed discovered weeks later by whoever holds it.

### ⚠️ They must be resized, not merely downloaded

The flat textures are already close to Discord's display size but still inconsistent
across entries — most are exactly 512×256, some run to 1024×512, and the two fallback
images are smaller and off-ratio. Each image is resized to fit 256px on its long edge and
written as PNG: comfortably above what Discord displays, so a future use (a directory page,
a larger card) is not immediately blocked by a too-small asset.

**Verified outcome (2026-09-03, flat-texture swap):** the 33 committed images total
**1.7 MB**. The largest is `Flag_Rooster.png` at **69,660 bytes** — well under the drift
test's 200,000-byte-per-file bound, with plenty of headroom even if `MAX_EDGE` is raised.
A landscape assertion was added to the drift test alongside the byte bound: every flat
in-game texture is wider than it is tall, which is exactly the property the earlier
portrait-gallery mistake violated and nothing previously checked.

### The fetch is a one-off script, and its output is committed

`apps/web/scripts/fetch-flags.ts` queries the API, applies the alias table, downloads,
resizes with `sharp`, and writes `apps/web/public/flags/<texture>.png`.

⚠️ **It does not run at build or deploy time.** A build that reaches out to a third-party
wiki is a build that fails when that wiki blocks it — which it already does for ordinary
requests — and one whose output can change without anything in this repository changing.
Run it by hand when the flag pool changes, which per `flags.ts` is never by design.

### ⚠️ A drift test pins the set

`CLAIMABLE_FLAGS` in `packages/domain/src/flags.ts` and the files in
`apps/web/public/flags/` are two statements of one fact, and the compiler cannot see the
second. A test reads the directory and compares. It fails when a flag has no image or an
image has no flag.

Same reasoning as `packages/db/test/holding-index-drift.test.ts`: the failure otherwise is
silent, and its symptom appears in a Discord channel rather than in a stack trace.

---

## 5. Serving, and the bot

### Static files, no image pipeline

Images serve from `public/flags/`, so `https://dayzclanwars.com/flags/Flag_Wolf.png` is a
plain static file. No Next image route, no optimization, no CDN configuration. Discord
fetches each once and caches it against its own infrastructure; nothing here is a hot path.

### The bot

`FLAG_IMAGE_BASE_URL`, optional, validated at load like `BOT_FEED_CHANNEL_ID`. Set,
`feed-embed.ts`'s resolver returns `${base}/flags/${texture}.png`. Unset, it returns null
and embeds post without a thumbnail exactly as they do today.

That is the entire change to the bot. The hook was built with this default precisely so
that adding artwork later would be one function.

⚠️ **The bot must never fetch the URL to check it.** A wrong base URL costs a missing
thumbnail — Discord simply renders the embed without one. A validating fetch would put a
third-party network call between a faction transition and its announcement, on the path
that CLAUDE.md's stop-on-failure rule already makes a blocking queue.

⚠️ **A trailing slash on the base URL yields a double slash.** Harmless on most servers and
not on all. The loader strips it, and a test pins that.

---

## 6. Deployment

### The image

`apps/web/Dockerfile`, multi-stage: a builder that installs the workspace and runs
`next build`, and a slim runtime carrying only Next's `standalone` output plus
`public/`. The existing `apps/ingest-worker/Dockerfile` is the pattern to follow for how
this repo builds a workspace package in Docker.

**Verified (2026-09-03) on both target architectures.** "Deployable" was the whole point,
so both were checked rather than assumed: native `docker compose build web` on
**linux/arm64** (the dev machine), and `docker build --platform linux/amd64` under QEMU
emulation for **linux/amd64**. Both resolved and installed the correct
platform-specific `sharp` binary from the lockfile (`@img/sharp-linuxmusl-arm64` /
`@img/sharp-linuxmusl-x64`) with no Dockerfile workaround needed — neither architecture
depends on an untested guess. If the eventual VPS is some third architecture, rebuild and
re-check before trusting this image there.

### Compose

Two services added to the **existing** root `docker-compose.yml`:

- `web` — built from that Dockerfile, `restart: unless-stopped`
- `caddy` — terminates TLS for `dayzclanwars.com` and reverse-proxies to `web`, with a
  `Caddyfile` checked in and a named volume for its certificate store

They go in the existing file rather than a new one because the stated end state is a
single box: when the bot, the worker and Postgres move to the VPS, that file already
describes the whole stack and the move is a migration rather than a re-architecture.

⚠️ Today the VPS brings up **only** `web` and `caddy`. The compose file also describes
`postgres` and `ingest-worker`, which must NOT be started there — a second empty Postgres
on the VPS would look like a working database and hold none of the live data.

### ⚠️ Prerequisites the deploy cannot satisfy for itself

- A DNS **A record** for `dayzclanwars.com` pointing at the VPS, propagated, before Caddy
  starts. Caddy's ACME challenge fails without it, and it will retry against Let's
  Encrypt's rate limits.
- Ports **80 and 443** reachable. 80 is not optional — it carries the HTTP-01 challenge.

### Where the database is not

`factions_live` runs in Docker on the machine that also runs the bot and the ingest
worker. It is not on the VPS and is not reachable from it.

This is stated because the direction note's features all read that database, and the
intended resolution is to move the whole stack to the VPS later — at which point the web
app reads Postgres over the compose network, with no public exposure. Until then, any
proposal for a data-driven page on this site has an unstated prerequisite, and this
paragraph exists so that whoever writes that proposal finds the prerequisite first.

---

## 7. On reusing the wiki's images

These are Bohemia Interactive's game assets, mirrored on a Fandom wiki. We would be
serving them to identify those same in-game items, for a private community server for that
game, non-commercially.

That is ordinary practice for game community sites and the practical risk is low. It is
not a settled legal right, and nobody qualified has reviewed it — recorded here as a
judgment that was made, rather than left implied. If it ever needs undoing, the images are
33 files in one directory and the resolver falls back to null, which is the state the feed
runs in today.

---

## 8. Testing

The app does almost nothing, so the tests are few and each one guards a silent failure:

- **Flag drift** — every texture in `CLAIMABLE_FLAGS` has a file, and every file has a
  texture.
- **The alias table** — covers exactly the textures the plain `<texture>.png` rule fails
  to find, and no others. This is what stops the Sakhal case from being re-broken by a
  future tidy-up of the mapping.
- **The bot's resolver** — base set yields the right URL; unset yields null; a trailing
  slash does not produce a double slash.
- **Config** — `FLAG_IMAGE_BASE_URL` optional, empty string treated as unset, malformed
  value rejected at load.

Not tested: that the page renders. It is one static route with no logic, and a snapshot of
its markup would fail on every copy edit while proving nothing.

---

## 9. Deploy record

A runbook in `docs/deploy/`, following the existing ones: DNS and port prerequisites, the
image build, bringing up `web` and `caddy`, verifying the certificate and that
`/flags/Flag_Wolf.png` returns 200 with `image/png`, then setting `FLAG_IMAGE_BASE_URL` on
the bot and restarting it as a single instance — the same zero-survivor check every bot
restart in this project requires.

Acceptance is a feed embed carrying a thumbnail. Two honest ways to get one:

- **Wait for the next real transition.** Costs nothing, but the timing is not ours — the
  live server currently holds one active faction and may not transition for days.
- **Re-queue a backfilled row** (`update faction_events set posted_at = null where id = 2`)
  and let the next tick repost it. ⚠️ This posts a duplicate embed into a public channel
  that real players can see. It is recoverable — delete the message — but it is a
  deliberate blemish on the record, so it is a choice to make out loud rather than a
  routine verification step.

Neither is a blocker for the deploy itself: the site, the certificate and a 200 on
`/flags/Flag_Wolf.png` are all verifiable without touching the bot at all.
