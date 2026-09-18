# Release announcements in Discord — deploy

Every release now announces itself. `CHANGELOG.md` is the single source of truth: a
version becomes a Discord post the moment it has a dated `## [x.y.z] - YYYY-MM-DD`
heading and a row for it exists in `release_announcements`. Design:
`docs/superpowers/specs/2026-09-17-release-announcements-design.md`.

⚠️ `deploy/deploy-release.sh` runs `pnpm release:sync` itself, unconditionally, in the
bookkeeping block after every verified deploy — including the deploy that lands this
feature. By the time anyone opens this runbook, the backfill has already happened: all
23 releases are already rows in `release_announcements`, waiting on `RELEASE_CHANNEL_ID`.
There is nothing left for an operator to queue.

## 1. Prerequisite: migration 0038

`0038` adds `release_announcements` — CREATE only, nothing dropped or altered, so the
bot does not need stopping to apply it. It lands in the normal course through
`clan-wars-deploy.timer`. Confirm it landed:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "\d release_announcements"

## 2. Confirm the deployer already queued the releases

This is not a check that a backfill is needed — it's confirmation that the deploy
already did it, so the next step is safe:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements"
    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements where posted_at is null"

Both should read **23**. That is the expected, healthy state — every release queued,
none posted yet, because `RELEASE_CHANNEL_ID` isn't set. If you also run

    cd /opt/clan-wars
    pnpm release:sync --dry-run

it will print `release:sync: nothing to queue; every release is already announced or
queued.` — that line is **success**, not failure. It reads like an error only if you
expect the 23-line dry-run listing from a from-scratch backfill; here there is nothing
left to list.

If either count is not 23, the deploy's `release:sync` step failed — see §9 (Repair)
below before continuing.

## 3. Enable — the irreversible step

⚠️ This is the step that starts the flood. The 23 rows are already sitting in
`release_announcements` with `posted_at is null`; setting the channel id and restarting
the bot is what makes it drain them.

Add to `/opt/clan-wars/.env`:

    RELEASE_CHANNEL_ID=1549900456078090260

then

    sudo systemctl restart clan-wars-bot

Confirm the warn is gone:

    journalctl -u clan-wars-bot --since "2 min ago" | grep -i release

`RELEASE_CHANNEL_ID is unset` must **not** appear. If it still does, the `.env` edit
didn't take — check you edited the file the unit actually reads, not a copy.

Nothing already posted is retracted (§6), so don't restart into the wrong channel to
"see what happens" — pick the real one first.

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
- **Setting `RELEASE_CHANNEL_ID` is not harmless here.** Because the deployer already
  queued all 23 releases before this runbook is ever opened, setting the channel id and
  restarting the bot (§3) is what starts the flood, immediately — there is no separate
  backfill step left to sequence it against. Don't set it until you've confirmed (§2)
  which channel you actually want 23 permanent messages in.
- **A version with no changelog section is never announced, silently.** No error, no
  warning — `parseChangelog` simply never sees it. `release:sync --dry-run` is the way
  to find one: count its output against how many releases you expect. Its "nothing to
  queue" message (§2) is silent about this too, so if you suspect a missing section,
  check `select count(*) from release_announcements` against the changelog directly
  rather than trusting the dry-run alone.

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

## 9. Repair: running `pnpm release:sync` by hand

Normally nobody runs this. It is the deploy's own bookkeeping step
(`deploy/deploy-release.sh`), and it is idempotent — it queues only versions that have
no row yet, so it is always safe to re-run. The only reason to run it by hand is that
the deploy's own call failed: `deploy-release.sh` alerts `CRITICAL` with `"$TAG is live
but its release notes were not queued; run 'pnpm release:sync' in $REPO"` when it does,
which is what should send you here, not a hunch.

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

If a normal repair (the deploy's queue call having failed) is what brought you here,
read the output: however many releases are actually missing, ascending, with
`1.16.2` and `1.16.4` absent (both carry the `[WITHDRAWN]` heading suffix and are never
announced — see §7 above). If that looks right:

    pnpm release:sync

then re-check §2's counts.
