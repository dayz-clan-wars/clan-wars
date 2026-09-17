# Acceptance: automatic deployment on release

**Date run:** 2026-09-17, 02:20–18:00 UTC
**Runbook:** `docs/deploy/2026-09-16-auto-deploy.md` (executed; this is its record)
**Design:** `docs/superpowers/specs/2026-09-16-auto-deploy-design.md`
**Operator:** Claude, over SSH as `acab@regime`, on the user's instruction
**Outcome:** the runbook's three-rehearsal gate passes. Rehearsal 2 failed on its
first run, took production down for about six minutes, and was re-run to a pass
after the fix.

## What is now live

`clan-wars-deploy.timer` polls every two minutes for a release tag merged into
`origin/main` that is newer than `/var/lib/clan-wars/deployed-tag`, and deploys
it: stop all three writers, dump `factions_live`, checkout, `pnpm install`,
build both images, apply migrations, reload nginx, start the services, health
check, start the bot last. Anything that fails after the checkout rolls code,
both image tags, host config and the database back together.

## Releases cut during acceptance

| Tag | What it was | Result |
|---|---|---|
| `v1.16.1` | rehearsal 1 — no-op release | deployed, 22 s downtime |
| `v1.16.2` | rehearsal 2 — deliberately unhealthy | **rolled back; the rollback failed** |
| `v1.16.3` | the retag fix | applied by hand |
| `v1.16.4` | rehearsal 2, re-run | **rolled back cleanly, 1 m 57 s** |
| `v1.16.5` | revert of the sabotage | deployed **by the timer**, 20 s |
| `v1.16.6` | two defects found after the gate | applied by hand |

`v1.16.2` and `v1.16.4` are recorded as WITHDRAWN in `CHANGELOG.md` rather than
deleted: the production host's failure marker named `v1.16.2` for several hours,
and a tag that a live marker points at should not be a mystery later.

## Rehearsal 1 — no-op release

`v1.16.1` deployed on the timer. **22 seconds** of downtime. A manual `pg_dump`
was taken first and proven restorable by round-trip into a scratch database
under `-v ON_ERROR_STOP=1`, row counts identical to live — rehearsal 3's check,
done up front where it cost nothing.

Two defects had already been found by installing the thing on the host, neither
of which six rounds of review caught:

- `pnpm` prints a lifecycle banner to stdout before a script's own output, and
  the deployer fed that banner to a JSON parser. **Every deploy would have
  failed at its first step** (`v1.16.1`, PR #14).
- An untracked `/backups/` directory on the host would have made the dirty-tree
  guard refuse every deploy (PR #13).

## Rehearsal 2, first run — the rollback failed

`v1.16.2` published `web` with `command: ["sh","-c","sleep infinity"]`: the
container starts, so compose reports success, but nothing answers the health
check. The failure lives in the release, which is the property the rehearsal
needs — reverting the release is what fixes it.

The deployer detected the unhealthy release and began the rollback correctly.
Then `retag_previous_images` resolved its target with:

    docker compose config --images web | head -1

That command lists the service's image **and its dependencies'**, so it returned
`postgres:16-alpine`, and both retags ran against it:

    docker tag clan-wars-web:rollback           postgres:16-alpine
    docker tag clan-wars-ingest-worker:rollback postgres:16-alpine

The database's image tag now pointed at an application image. Postgres entered a
restart loop, the rollback could not start the restored release, and
`rollback_abort` did what it is designed to do: stopped everything, alerted
CRITICAL, named the dump, and refused to retry.

**Production was down about six minutes and recovered by hand** —
`docker pull postgres:16-alpine`, `up -d postgres`, retag web and worker from
their pins, start the services, start the bot, disable the timer. No data was
lost: 4 clans / 17 links / 12 members / 37 migrations / 14,946 events, the event
count *higher* than before because the worker re-ingested from the ADM logs.

Six of the seven capabilities held under a real failure. The seventh was the one
the final whole-branch review had flagged as unverifiable from a diff:

> ⚠️ Cannot verify from diff: whether `docker compose config --images
> ingest-worker` resolves the worker's real image name is unverifiable off-host.

It was the only assumption in the system that could not be checked without the
host, it sat in a destructive path, and it was wrong. The lesson recorded at the
time: **an unverifiable assumption in a destructive path must be verified before
that path is armed**, not after.

## The fix (`v1.16.3`, PR #17)

The image name is derived from the compose project name — `<project>-<service>`,
which is what compose itself uses for a build-only service — resolved once in
the preflight and verified there against a real image. If it cannot be resolved,
the deploy refuses while nothing is stopped. The rollback pins share that
derivation instead of keeping a second hardcoded copy.

Verified on the host rather than reasoned about, with the old code's answer
alongside it:

    project=clan-wars
    clan-wars-web:latest           -> cf380f15bb73
    clan-wars-ingest-worker:latest -> 71bfa7329bd7

    what the old code picked:  postgres:16-alpine

Rejected after testing on the host: `docker compose config --format json` reports
`image: null` for build-only services, and `docker compose images --format json`
does not populate the service name on compose 5.4.0.

## Rehearsal 2, re-run — pass

Counts before: **4 clans / 18 links / 12 members / 37 migrations / 15,091
events**. Links had moved 17 → 18 since the first run: a real player linked in
between, so this ran against live activity rather than a quiet database. A fresh
manual dump was taken and proven restorable by round-trip, counts identical,
scratch database dropped.

| Time (UTC) | |
|---|---|
| 17:21:01 | all three writers stopped, dump taken, tree at `v1.16.4` |
| 17:22:38 | health check failed — `[ROLLING BACK]` |
| 17:22:58 | `bot ready as Clan Wars#3900` |
| 17:23:01 | `[ROLLED BACK] restored v1.16.3` |

**1 minute 57 seconds of downtime, including a full drop-and-restore of
`factions_live`, with no human involved.**

The retag hit the right targets this time:

    docker tag clan-wars-web:rollback           clan-wars-web:latest
    docker tag clan-wars-ingest-worker:rollback clan-wars-ingest-worker:latest

And the tell that matters most, from `docker compose ps` immediately afterwards —
the same command that exposed the clobber the first time:

    postgres  postgres:16-alpine  Up 55 minutes (healthy)

Postgres was never touched and never restarted.

All seven capabilities proven: health check detects an unhealthy release; the
database is dropped and restored from the deploy's own dump against real data;
the tree rolls back; **both image tags roll back**; the failure marker stops the
two-minute retry loop; `rollback_abort` stops rather than thrashing; the alerts
name what happened and which dump to recover from.

## Rehearsal 3 — the restore round-tripped

Counts after the rollback: **4 clans / 18 links / 12 members / 37 migrations /
15,140 events**. Identical except `events`, which is *higher* because the worker
re-ingested from the ADM logs after the restore — the designed behaviour, and
the reason `events` is the one table that is reconstructible.

## First unattended deploy

With the sabotage reverted, `v1.16.5` was tagged and the failure marker cleared.
The timer deployed it with no manual step of any kind:

    17:45:14  deploying v1.16.3 -> v1.16.5 (host-config=False migrations=False)
    17:45:34  [DEPLOYED] v1.16.5 is live

Twenty seconds. Verified afterwards: site 200 over TLS, `bot ready`, 4 players
online, notices posting, positions projecting, sessions tracking, timer cycling
clean no-ops.

## Two defects found after the gate passed (`v1.16.6`)

Verifying the `v1.16.5` deploy turned up two more silent failure modes. Both were
fixed before the deployer was left armed.

**The deployer rewrote itself mid-run.** The deploy moves the tree to the new
tag, which replaces `deploy-release.sh` while bash is executing it, and bash
reads a script lazily by byte offset rather than loading it whole. Reproduced in
isolation: the victim script stopped executing at the rewrite and **exited 0** —
which in a deploy means three writers stopped, a marker written, a migration
possibly half-applied, and systemd told it succeeded. The deployer now re-execs
from a private copy, unlinked immediately, with `argv[0]` preserved so journald
keeps labelling the lines `deploy-release.sh`.

**A deploy could report success while running the previous image.** On the
`v1.16.5` deploy, `docker compose up -d` *started* the stopped containers again
rather than recreating them on the freshly built image; `web` and
`ingest-worker` are build-only services whose definitions name no image, so an
unchanged definition can look up to date. That release was harmless — the two
images were verified byte-identical in layers and config — but the same path
with real code changes is a silent stale-code deploy, and no health check can
see it because the previous image is perfectly healthy. The deployer now passes
`--force-recreate`, which costs nothing because `stop_all` has already stopped
both containers.

⚠️ `v1.16.3` and `v1.16.6` were both applied to the host **by hand**, with the
timer disabled. Deploying a change to the deployer through the deployer is the
one case where the running script and the shipped script differ, and for
`v1.16.6` it is precisely the defect being fixed.

## What this acceptance does not establish

- **No release with real application code changes has been deployed by the timer
  yet.** Every release in this table changed only the deployer, the compose file
  or the changelog, so every image build was a cache hit. The migration path in
  particular has never run with a migration actually pending on a timer deploy;
  `pnpm db:migrate --apply --production` ran, found nothing, and exited.
- The `--force-recreate` fix makes the stale-image question moot rather than
  answering it. What compose would have done with a genuinely different image
  was never determined.
- Rehearsal 2 proves the rollback from a **failed health check**. The other
  rollback triggers — a failed migration, a failed nginx reload, a failed build —
  have not been exercised against production, only reasoned about and tested.
