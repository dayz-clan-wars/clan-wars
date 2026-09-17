# Release announcements — design

2026-09-17

Every release this project has ever cut, and every release it cuts from now on,
posts its own notes to a Discord channel. The notes come from `CHANGELOG.md`,
the announcement fires after a **deploy** succeeds rather than when a tag is
pushed, and the backfill and the per-deploy hook are the same code path.

This document also covers the prerequisite: `CHANGELOG.md` currently records
v1.16.0 onward and nothing before it, so there is nothing to announce for the
first sixteen releases until it is backfilled.

---

## 1. Why this shape

Three things were possible and two were rejected.

**A GitHub Actions workflow on `release: published`** is the smallest thing that
could work — one workflow, one webhook secret, no migration, no bot change. It
was rejected because it announces the *tag*, not the *deploy*. Since 2026-09-16
a tag reaches production through `clan-wars-deploy.timer`, which can and does
roll a release back (v1.16.2 and v1.16.5 were rehearsals of exactly that). A
workflow firing on the push would tell players a release is live while the
deployer is restoring the previous one. It also cannot do the backfill: only 5
of the 25 existing tags have GitHub Releases, so the history would have to be
manufactured there first.

**`deploy-release.sh` curling a webhook directly** ties the message to the real
deploy, which is right, but gives up everything the other posters in this repo
have: no record of what was posted, no retry, no ordering guarantee, and a
separate one-off script for the backfill. The deployer already has an `alert()`
webhook for ops; adding player-facing posting to a bash script is the wrong
place for text that needs splitting and formatting.

**A queue table the deployer fills and the bot drains** is what the rest of this
system does — `faction_events`, `war_log_events`, `clan_notices` and
`vehicle_wipe_announcements` are all this shape — and it is the only one of the
three where the backfill is not special: the backfill and the deploy hook are
the same `release:sync` call, and the difference between them is only how many
rows it happens to insert.

## 2. Source of truth

`CHANGELOG.md`, and nothing else.

The tag annotations are richer for v1.1.0–v1.15.0 and the GitHub Release bodies
are richer for a few more, but three sources of one fact drift three ways. The
changelog is the one a CI gate already defends (`.github/workflows/changelog.yml`
fails a PR with no `## [Unreleased]` entry), the one `keel:release` rolls on
every release, and the one a human already reviews. So the announcement is a
rendering of the changelog section, and improving an announcement means editing
the changelog.

The audience is players, and the posts carry the changelog prose as written —
occasionally including a migration number or a file path. That is accepted: one
source of truth is worth more than a curated second copy that goes stale.

⚠️ The one thing the changelog does not carry is a **title**. Keep a Changelog
sections are `## [1.17.0] - 2026-09-17` with no subject line, while the tag
annotations carry the good ones ("automated base-zone enforcement", "the raid
weekend opens and closes itself"). `release:sync` therefore reads the annotated
tag's subject for the post's title *where the tag has one beyond the bare
version*, and falls back to `vX.Y.Z`. v1.16.0–v1.17.0 were tagged without
subjects and will post untitled; that is a fact about those tags, not a bug to
work around.

## 3. Components

### 3.1 `packages/deploy/src/changelog.ts` — parsing

Pure. No database, no network, no filesystem: it takes the text of
`CHANGELOG.md` and returns the releases in it.

```ts
export interface ChangelogRelease {
  version: string;      // "1.17.0", without the leading v
  date: string;         // "2026-09-17", as written in the heading
  body: string;         // everything under the heading, trimmed
}

export function parseChangelog(text: string): ChangelogRelease[];
```

`## [Unreleased]` is skipped — it is not a release and has no date. Sections are
returned in **ascending semver order** using `compareSemver`, which already
lives in this package for `selectNewestTag`. Ascending, not file order: the file
is newest-first, and the insert order below is what fixes the posting order.

`packages/deploy` rather than `packages/domain` because `@factions/domain` holds
*game* rules — the guide's numbers, the sentencing ladder, the restart slots —
and a changelog is not one. This package already exists for exactly this kind of
pure deploy-system logic and already has the semver comparison.

### 3.2 Migration 0038 — `release_announcements`

```
id           serial primary key
version      text not null unique
released_at  timestamptz not null      -- the tag's date, from the changelog heading
title        text                      -- null when the tag carried no subject
body         text not null             -- the changelog section, markdown, verbatim
queued_at    timestamptz not null default now()
posted_at    timestamptz               -- null means pending
```

⚠️ No `attempts` and no `failed_at`, unlike `clan_notices`. Those exist there
because a notice's targets are independent — a stuck target must not block a
different one, so a notice is given up on after three tries. A release queue is
the opposite: order is the whole point, so a failure blocks and keeps retrying
until a human unblocks it, exactly as `war_log_events` does. Columns nothing
writes are two statements of one fact waiting to disagree.

Insert-only, drained by one reader. It goes **last in the lock order** (spec
§4.12), after `clan_notices` and the zone-enforcement tables, and can safely: it
is written by a single statement from a single writer that touches no other
table, exactly like `server_restarts` and `vehicle_wipe_announcements`.

CREATE only — no column is dropped or altered, so this migration does **not**
require stopping the bot, and the deployer applies it in the normal course.

⚠️ **This table is the only thing that prevents a re-post.** Truncating it, or
restoring a database dump taken before a release was announced, re-announces
every release it no longer records. That is the cost of not keeping the state in
Discord, and it is the same trade every other queue here makes.

### 3.3 `scripts/release-sync.ts` — `pnpm release:sync`

Reads `CHANGELOG.md` from the working tree, parses it, and inserts a row for
every version that does not already have one, in ascending semver order.

```
pnpm release:sync            # insert every unannounced version
pnpm release:sync --dry-run  # print what it would insert, write nothing
```

- **Idempotent.** `on conflict (version) do nothing`. Running it twice inserts
  nothing the second time; running it after a deploy that already ran it is a
  no-op.
- **Ascending insert order is the posting order.** `id` is assigned by insert,
  and §3.4 posts by `id`. Sorting at insert is what makes v1.0.0 appear above
  v1.10.0 in the channel — a lexical sort would not.
- **Title from `git tag -l --format='%(contents:subject)' v<version>`**, taken
  only when it differs from the bare version string. A missing tag (a changelog
  section written before the tag exists) yields a null title, not a failure.
- **Guarded like the other scripts.** It refuses a `DATABASE_URL` that does not
  end in `/factions_live` unless `--allow-test-db` is passed, matching `wipe`,
  `launch` and `rebuild:standings`.

This single script is the backfill, the per-deploy hook, and the repair tool for
a deploy that succeeded without announcing. There is no second code path, so
there is no second code path to get wrong.

⚠️ A version with no changelog section is never announced, silently. The
changelog CI gate makes that unlikely but not impossible — `release:sync
--dry-run` is the check, and the runbook says to run it after any release whose
message did not appear.

### 3.4 `apps/bot/src/release-tick.ts` — posting

The same contract as `feed-tick.ts` and `war-log-tick.ts`, and for the same
reason:

- Posts the oldest unposted row by `id`.
- **Post first, mark second.** At-least-once: a crash between the two re-posts
  that row on the next start. This is the direction this repo chooses
  everywhere (see `notice-tick.ts`).
- **Stops at the first failure**, with an error-level `release queue blocked
  at …` line. Skipping ahead would let a retried older release land below a
  newer one, and a release history whose order cannot be trusted is not a
  history.
- **One row per tick**, unlike `warLogTick`'s batch of 20. At
  `BOT_TICK_INTERVAL_MS` (10 s) the 25-release backfill lands over about four
  minutes rather than as a single wall of messages, and the pacing costs nothing
  in steady state, where there is at most one row to post.

Gated on `RELEASE_CHANNEL_ID` (`optionalSnowflake`, degrading like
`WAR_LOG_CHANNEL_ID`): unset means rows queue unposted and the bot logs one warn
line at startup. It runs among the posters, after `war-log-tick.ts`.

### 3.5 `apps/bot/src/release-text.ts` — rendering

Pure, beside `war-log-text.ts` and `announce-text.ts`. Turns a row into the
message or messages to send.

A Discord embed description caps at **4096 characters**. Bodies over that split
on `###` section boundaries, and a single section still over the cap splits on
paragraph boundaries; each piece after the first is posted as a follow-up
carrying `(2/3)` in its footer. v1.0.0's entry — one release covering increments
0–8 — is the one that will exercise this, and the parser's tests use it as a
fixture.

⚠️ Splitting happens at **post** time, not at insert time, so the row stays one
release. A release whose second message fails leaves the row unmarked and
re-posts the whole release on the next tick. Accepted: duplication of a message
is this system's chosen failure direction, and a release split across rows would
be able to interleave with the next one.

### 3.6 `deploy/deploy-release.sh` — the hook

One call, in the bookkeeping block at the end, beside `state_write` and the
marker cleanup:

```sh
run "$PNPM" release:sync \
  || alert "CRITICAL" "$TAG is live but was not announced; run 'pnpm release:sync' on the host"
```

⚠️ It sits **after `trap - ERR`**, deliberately. Past that disarm the deploy is
verified healthy and the bot is live; a failed announcement is worth an alert
and a re-run, never a rollback that would drop and restore `factions_live` out
from under a working release. This is the same reasoning the script already
applies to a failed `state_write`.

It runs from the newly deployed checkout, so it reads the new tag's
`CHANGELOG.md` and sees the new section.

## 4. The CHANGELOG backfill

A separate, earlier PR — content only, no code — because §3 has nothing to
announce without it.

`## [1.15.0]` down to `## [1.0.0]` are added below the existing `## [1.16.0]`
section, dated from the tags.

- **v1.1.0–v1.15.0**: each entry is built from that tag's annotation, which is
  substantial and already written in this project's voice, reorganised into
  `Added` / `Changed` / `Fixed` / `Removed` and cross-read against
  `git log <prev>..<tag>` for anything the annotation omitted. The ⚠️
  operational notes in those annotations ("ships dark", "PENDING is no longer
  empty") are kept — they are part of the record, and they are what a reader
  three months from now will need.
- **v1.0.0** has only a one-line annotation covering increments 0–8, roughly 700
  commits. It is written as a single entry reconstructed from the increment
  specs and runbooks: what the game *had* when 1.0.0 shipped, not a commit list.

## 5. Rollout

Runbook: `docs/deploy/2026-09-17-release-announcements.md`.

1. Merge the backfill PR.
2. Merge this feature; the deployer applies 0038 in the normal course.
3. Add `RELEASE_CHANNEL_ID=1549900456078090260` to `.env` and restart the bot.
4. `pnpm release:sync --dry-run`, read the list, then `pnpm release:sync`.
5. Watch the channel fill over about four minutes. 25 messages, oldest first.

⚠️ Steps 3 and 4 belong together. Rows inserted while no channel is configured
queue indefinitely, so an operator who sets `RELEASE_CHANNEL_ID` weeks later
gets the whole backlog at once with nothing having warned them. The first time
that flood happens it is the intent; every time after it is a surprise.

## 6. Testing

- `packages/deploy/test/changelog.test.ts` — parsing: heading forms, the
  `Unreleased` skip, ascending order across a 1.9.0/1.10.0 pair (the case a
  lexical sort gets wrong), a section containing a nested `##` in prose.
- `apps/bot/test/release-text.test.ts` — rendering and the 4096 split, with
  v1.0.0's real entry as a fixture; a body under the cap must produce exactly
  one message.
- `apps/bot/test/release-tick.test.ts` — posts oldest first; marks only after a
  successful post; stops at the first failure and reports the blocking id; does
  nothing when the queue is empty.

## 7. What this does not do

- No per-release opt-out. Every version with a changelog section is announced,
  including the v1.16.1–v1.16.6 deployer rehearsals. A "do not announce" flag is
  a column and a decision for whoever first wants one.
- No editing or deleting a posted message. A correction is a new release.
- No alerting on a blocked queue — it is an error-level log line and nothing
  else, the same known gap `CLAUDE.md` records for the faction feed.
