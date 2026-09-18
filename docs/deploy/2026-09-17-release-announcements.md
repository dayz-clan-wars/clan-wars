# Release announcements in Discord — deploy

Every release now announces itself. `CHANGELOG.md` is the single source of truth: a
version becomes a Discord post the moment it has a dated `## [x.y.z] - YYYY-MM-DD`
heading and `pnpm release:sync` has run against `factions_live`. Design:
`docs/superpowers/specs/2026-09-17-release-announcements-design.md`.

## 1. Prerequisite: migration 0038

`0038` adds `release_announcements` — CREATE only, nothing dropped or altered, so the
bot does not need stopping to apply it. It lands in the normal course through
`clan-wars-deploy.timer`. Confirm it landed:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "\d release_announcements"

## 2. Enable

Add to `/opt/clan-wars/.env`:

    RELEASE_CHANNEL_ID=1549900456078090260

then

    sudo systemctl restart clan-wars-bot

Confirm the warn is gone:

    journalctl -u clan-wars-bot --since "2 min ago" | grep -i release

`RELEASE_CHANNEL_ID is unset` must **not** appear. If it still does, the `.env` edit
didn't take — check you edited the file the unit actually reads, not a copy.

## 3. Backfill

⚠️ **`pnpm release:sync` is run ON THE PRODUCTION HOST, from `/opt/clan-wars` — never
from a laptop or a local checkout.** Its guard (shared by every production script in
`scripts/`) only refuses a `DATABASE_URL` that doesn't *end in* `/factions_live`; it
says nothing about *which host* that database lives on. A developer machine can have
its own, entirely local, database named `factions_live` — the guard passes, the rows
get written there, and the command prints success while production sits untouched and
nothing says so. Before running it, confirm you are actually on the production host:
it has `/opt/clan-wars` and `systemctl status clan-wars-bot` reports a real unit; a
laptop has neither.

    cd /opt/clan-wars
    pnpm release:sync --dry-run

Read the output: 23 lines, ascending from `1.0.0`, with `1.16.2` and `1.16.4` absent
(both carry the `[WITHDRAWN]` heading suffix and are never announced — see §7 below).
If that looks right:

    pnpm release:sync

Steps 2 and 3 belong together — see the hazard in §6.

## 4. Watch

The bot posts one release per tick, oldest first. At the default tick interval that's
roughly one message every 10 seconds — about four minutes for all 23 (not 25; the two
`[WITHDRAWN]` versions are never queued).

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements where posted_at is null"

Should reach 0.

## 5. If it blocks

The bot logs `release queue blocked at release_announcements row N` at error level and
stops — nothing behind that row posts, by design (same shape as the faction feed and
the war log: one stuck row blocks the queue rather than letting a later release post
out of order). Almost always the bot lacking **View Channel** or **Send Messages** on
the channel. Fix the permission; the next tick retries on its own. Nothing needs
restarting.

## 6. ⚠️ Hazards

- **The table is the only thing preventing a re-post.** Truncating
  `release_announcements`, or restoring a dump taken before a release was announced,
  re-announces the entire history into the channel the next time `release:sync` runs.
- **Steps 2 and 3 belong together.** Setting `RELEASE_CHANNEL_ID` before the backfill
  has run is harmless (nothing is queued yet to post); running the backfill before the
  channel id is set just queues rows that wait. But do them in order regardless — a
  channel id set mid-backfill on a differently-timed restart is an unnecessary variable
  to introduce into a one-time operation.
- **A version with no changelog section is never announced, silently.** No error, no
  warning — `parseChangelog` simply never sees it. `release:sync --dry-run` is the way
  to find one: count its output against how many releases you expect.

## 7. Suppressing one release

Mark its heading `## [X.Y.Z] - YYYY-MM-DD [WITHDRAWN]` — the same marker `v1.16.2` and
`v1.16.4` already carry — and it is never announced. `parseChangelog`'s heading regex
is anchored at both ends (`HEADING` in `packages/deploy/src/changelog.ts`), so the
trailing text fails the match entirely rather than being stripped.

⚠️ This only works **before** `release:sync` has queued that version. Once a row
exists in `release_announcements`, the marker does nothing — the row was already
written from the un-suffixed heading — and it must be deleted by hand:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "delete from release_announcements where version = 'X.Y.Z' and posted_at is null"

(Never delete a row that has already posted — that edits history the channel has
already shown, not the queue.)

## 8. Rollback

Unset `RELEASE_CHANNEL_ID` and restart. `release:sync` keeps queuing rows on every
deploy (it's unconditional — the gate is entirely in the bot's read side) and nothing
posts. Nothing already posted is retracted.
