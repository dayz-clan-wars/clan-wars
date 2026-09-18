# Release announcements in Discord — deploy

Every release now announces itself. `CHANGELOG.md` is the single source of truth: a
version becomes a Discord post the moment it has a dated `## [x.y.z] - YYYY-MM-DD`
heading and a row for it exists in `release_announcements`. Design:
`docs/superpowers/specs/2026-09-17-release-announcements-design.md`.

**Status: deployed 2026-09-18, v1.18.0.** The first backfill had to be run by hand (§2
below explains why — it is not optional, and it is not a repair for something that went
wrong). `pnpm release:sync` then queued 24 releases and the bot posted all 24 with no
failures.

⚠️ `deploy/deploy-release.sh` runs `pnpm release:sync` itself, unconditionally, in the
bookkeeping block after every verified deploy — but **not on the deploy that lands this
feature**. The script re-execs from a private copy of itself before it moves the tree to
the new tag (the v1.16.6 fix, so a mid-deploy rewrite of the running script can't strand
bash at a stale byte offset); the consequence is that the deployer that ships tag N is
tag N−1's copy of the script. v1.18.0 added the `release:sync` call; v1.17.0's copy of
`deploy-release.sh` is what executed the v1.18.0 deploy, and that copy has no such call.
This is a general fact about `deploy/deploy-release.sh`, not particular to this feature —
see `CLAUDE.md`. So: the deploy that introduces the hook cannot itself have run it, the
table is empty when this runbook is first opened, and §2 below is a required manual step,
not confirmation of something already done.

## 1. Prerequisite: migration 0038

`0038` adds `release_announcements` — CREATE only, nothing dropped or altered, so the
bot does not need stopping to apply it. It lands in the normal course through
`clan-wars-deploy.timer`. Confirm it landed:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "\d release_announcements"

## 2. Queue the backfill by hand — required, not a check

The deploy that lands this feature runs on tag N−1's copy of `deploy-release.sh` (see
the note above), which has no `release:sync` call in it at all. So the first thing to
confirm here is **that the table is empty**, not that it is already full:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements"

Zero rows is the expected, healthy state for a first deploy of this feature — it means
nothing failed, the hook simply never ran. Queue it by hand, from the production host:

    cd /opt/clan-wars
    pnpm release:sync --dry-run

Read the list before committing to it. The count is not a fixed number — it's every
dated, non-`[WITHDRAWN]` section `CHANGELOG.md` holds at the moment you run this. At
v1.18.0 that's **24**, not 23: the release that finally makes this hook fire announces
*itself*, because `release:sync` reads the checkout at the new tag, and that checkout's
`CHANGELOG.md` already carries the v1.18.0 section. 23 was the count only before v1.18.0
existed — don't carry that number forward into a future deploy; count the dated sections
instead. If the dry-run list looks right:

    pnpm release:sync

Then confirm it landed:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements"
    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from release_announcements where posted_at is null"

Both should read the same count as the dry-run listing (24 at v1.18.0) — every release
queued, none posted yet, because `RELEASE_CHANNEL_ID` isn't set.

**From the next release onward this is automatic.** v1.18.0's own copy of
`deploy-release.sh` carries the `release:sync` call, so the deploy that ships the
release after it runs the call itself. Confirmed on 2026-09-18: the v1.18.1 deploy
logged `release:sync: queued 1.18.1` before `[DEPLOYED]`, with nobody at a terminal.
This manual step is one-time, for the deploy that introduces the hook only — see §9 for the unrelated case (a deploy that already has the call, but the
call itself failed).

## 3. Enable — the irreversible step

⚠️ This is the step that starts the flood. §2 put 24 rows in `release_announcements`
with `posted_at is null`; setting the channel id and restarting the bot is what makes
it drain them.

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
roughly one message every 10 seconds — about four minutes for all 24 (the two
`[WITHDRAWN]` versions are never queued; the count itself is every dated,
non-`[WITHDRAWN]` changelog section at the moment `release:sync` ran, not a fixed
number — see §2).

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
- **Setting `RELEASE_CHANNEL_ID` is not harmless here.** Once §2 has queued the backfill,
  setting the channel id and restarting the bot (§3) is what starts the flood,
  immediately — there is no separate backfill step left to sequence it against. Don't
  set it until you've decided which channel you actually want two dozen-plus permanent
  messages in.
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

§2 above is the *first* reason to run this by hand: the deploy that introduces the hook
can't have run its own copy of it. This section is the *second, ongoing* reason, for
every deploy after that: normally nobody runs this by hand at all, because it is the
deploy's own bookkeeping step (`deploy/deploy-release.sh`) from then on, and it is
idempotent — it queues only versions that have no row yet, so it is always safe to
re-run. The only reason to run it by hand once the hook is in place is that the deploy's
own call failed: `deploy-release.sh` alerts `CRITICAL` with `"$TAG is live but was not
announced; run 'pnpm release:sync' on the host"` when it does, which is what should send
you here, not a hunch.

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
