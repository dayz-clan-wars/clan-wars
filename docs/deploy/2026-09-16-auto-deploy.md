# Automatic deployment on release

2026-09-16. Design: `docs/superpowers/specs/2026-09-16-auto-deploy-design.md`
(⚠️ amended twice since it was written — read those amendments; the shipped
script's start order and its rollback's losslessness both differ from the
original text). Script: `deploy/deploy-release.sh`. Units:
`deploy/systemd/clan-wars-deploy.{service,timer}`. Install steps for the
symlinks also live in `deploy/README.md`; this file is the operator's runbook
— read both.

## What this reverses

Until today, `CLAUDE.md` said nothing applies migrations automatically, and
said so because of a real incident: on 2026-09-02 the bot looped on
`dormancy tick failed … column "dormant_since" does not exist` until `0015`
was applied by hand. That is now false. `clan-wars-deploy.timer` runs
`deploy/deploy-release.sh` every two minutes; on a new tag it stops all three
writers, dumps `factions_live`, checks out the tag, and only then runs
`pnpm db:migrate --apply --production` — rolling code, image, host config and
schema all back together if anything from that point fails. What makes this
safe rather than merely automated is the **stop-first ordering**: the dump is
taken after every writer that touches `factions_live` is stopped, which is
what turns "restore the database" from a data-loss event into an exact undo
at most of the failure points (see the design doc's §4 amendment for the two
call sites where that is no longer exactly true, and why).

## 0. Prerequisite: `acab`'s passwordless sudo

**Verify this before anything else.** The script runs as `acab`
(`deploy/systemd/clan-wars-deploy.service`) and calls `sudo -n` — non-interactive,
so a missing sudoers entry doesn't prompt, it fails the call outright — for
every privileged step: `docker`, `docker compose`, `systemctl`, and
`nginx -t`/`reload`. Without every one of these granted, the script dies at
its first privileged call, mid-preflight or mid-outage depending on which
command it hits first, and the failure mode differs by exactly where it
happens.

Check the sudoers entry names these command groups (or `ALL`) with `NOPASSWD`,
then confirm each one actually runs non-interactively as `acab`:

    sudo -l -U acab

    sudo -u acab sudo -n docker compose ps >/dev/null && echo OK
    sudo -u acab sudo -n systemctl status clan-wars-bot >/dev/null && echo OK
    sudo -u acab sudo -n nginx -t && echo OK

Each should print `OK` (or nginx's own success message) with no password
prompt. A prompt means the entry is missing or wrong — fix it before going any
further; every later step assumes this already works.

## 1. Install

**The state directory must be owned by `acab`, and this order matters.**

    sudo install -d -o acab -g acab /var/lib/clan-wars

⚠️ If this directory is root-owned instead, the script's two writes under it —
the deployed-tag state file on every success, and the failure marker on every
failure — both fail silently from the script's own point of view (it alerts,
but does not stop). The state-file failure is the dangerous one: it happens
**after a deploy that already succeeded** — services are up, the migration
applied, the bot is live — so the tag is simply never recorded. Two minutes
later the timer polls again, sees the same "new" tag against the stale state
file, and redeploys it: a full stop/dump/migrate/start outage, repeated every
two minutes, forever, with every deploy individually reporting success. Fix
the ownership, don't just watch it happen — a future `sudo mkdir
/var/lib/clan-wars` (recreating the directory as root) reintroduces this
exact loop.

**Seed the state file with the tag currently live**, written as `acab` so it
matches the directory:

    echo v1.15.0 | sudo -u acab tee /var/lib/clan-wars/deployed-tag

(Substitute the real tag. Skipping this makes the very first run "deploy" the
newest tag over whatever is actually live already, with no state to compare
against.)

**Add the webhook**, in `/opt/clan-wars/.env`:

    DEPLOY_WEBHOOK_URL=<discord webhook url>

Create it in the ops channel: Channel Settings → Integrations → Webhooks. Never
commit it — `.env` is gitignored and always has been. This is deliberately
independent of the bot: the bot is stopped for most of a deploy and may be the
thing that failed, so it cannot also be the channel that reports the failure.

**Symlink and enable the units:**

    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.service \
      /etc/systemd/system/clan-wars-deploy.service
    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.timer \
      /etc/systemd/system/clan-wars-deploy.timer
    sudo systemctl daemon-reload

⚠️ **Do not `enable --now` the timer yet.** Step 2 (the dry run) and the
rehearsals in step 4 both need to run first — see `deploy/README.md`'s note on
why an unrehearsed rollback triggered by the timer, on whatever tag happens to
be first, is not an acceptable way to find out it works.

## 2. The dry run — required, and it cannot happen anywhere but here

    cd /opt/clan-wars && ./deploy/deploy-release.sh --dry-run

Every mutating command in the script goes through a `run()` wrapper that,
under `--dry-run`, prints `DRY: <command>` instead of executing it — that
printed transcript is the reviewable artifact. Read it end to end before
enabling anything.

⚠️ **This genuinely cannot be exercised end to end anywhere but this host,
first.** It is not merely "the safe way to check" — a developer machine can't
complete the run at all: no `flock` contention to model the way the real lock
file does, no `/home/acab/.local/bin/pnpm` at that path, and the dump
verification uses `stat -c %s`, which is GNU-only (macOS's `stat` takes
different flags and errors out). So the dry run on the production host, by
hand, is the first point in this project's life the script has ever run start
to finish at all. Treat it as exactly that, not as a formality on the way to
enabling the timer.

## 3. Enable the timer

    sudo systemctl enable --now clan-wars-deploy.timer
    systemctl list-timers clan-wars-deploy
    journalctl -u clan-wars-deploy -n 20

Expect the timer listed with a next-elapse time, and (assuming step 1's seed
matches the currently-deployed tag) a run that exits 0 with nothing printed —
the no-op path, silent by design (§2 of the spec: an alert on every two-minute
no-op is 720 messages a day, and a channel nobody reads is not an alert
channel).

## 4. Rehearsal — a gate, not a suggestion

⚠️ **Until both of these have been run, the rollback is a design, not a
capability, and must not be described as one** (spec §8). This is not a
formality to skip under time pressure — it is the only way anyone will know,
before it matters, whether `rollback()` actually restores `factions_live`
correctly on this host.

**Rehearsal 1 — no-op release.** Tag a commit that changes nothing:

    git tag v1.9.1 && git push origin v1.9.1

Watch `journalctl -u clan-wars-deploy -f`. Expect the full path to run with
nothing at stake — stop, dump, checkout, migrate (a no-op), reload nginx,
start `web`/`ingest-worker`, health check, start the bot, `bot ready as v1.9.1`,
state write — a `DEPLOYED` webhook, and roughly 1–3 minutes of downtime.

**Rehearsal 2 — deliberate rollback, while watching.** Temporarily break the
health check so it cannot pass — e.g. point `services_ok`'s curl at a port
nothing serves — tag a release, and watch it fail on purpose. Confirm, in
order:

- the webhook says `ROLLING BACK`, then `ROLLED BACK`;
- `factions_live` is back (the dump-then-restore actually round-tripped);
- `git describe --tags` on the host reports the **previous** tag, not the one
  that failed;
- the site answers again (`curl -fsS http://127.0.0.1:3020/`);
- the bot is running the previous release.

Then revert the sabotage and confirm a normal deploy still works. Do this at a
quiet hour, at a terminal, with `/var/backups/clan-wars/` in view so you can
watch the dump appear.

## Deploying by hand, if the timer is off

The script takes no arguments beyond `--dry-run`; it always targets the
newest semver tag reachable from `origin/main` that isn't already the current
state. Running it manually is identical to letting the timer fire once:

    cd /opt/clan-wars && sudo -u acab ./deploy/deploy-release.sh

Everything downstream — preflight, stop, dump, checkout, migrate, health
check, bot start — is the same path either way; the timer is only what
schedules it.

## Disabling it in a hurry

    sudo systemctl disable --now clan-wars-deploy.timer

This stops future polls; it does **not** touch a deploy already in progress
or revert anything a completed deploy already did. Nothing else needs to
change — the bot, web and ingest-worker keep running whatever release was
last deployed, exactly as before the timer existed. Deploys go back to the
manual `pnpm db:migrate` / `docker compose build && up -d` path documented
elsewhere in `CLAUDE.md` and `docs/deploy/2026-09-14-db-migrate.md`.

## Where pre-deploy dumps land

    /var/backups/clan-wars/predeploy-<tag>-<UTC timestamp>.sql.gz

Timestamped per attempt, not keyed on the tag alone — a second attempt at the
same tag (the ordinary case right after a human clears a `FAILED` marker, see
below) dumps a database the first attempt's migration has already touched, so
overwriting the first dump would destroy the one artifact a rollback from
*that* attempt could have restored from. These share the volume the nightly
`clan-wars-backup.timer` dumps use (`deploy/backup/backup-factions-live.sh`),
which only ever rotates its own `factions_live-*` files, so nothing else
prunes `predeploy-*` — the script does that itself, keeping the **newest 14**,
and only after a dump has passed its own integrity check (so a run of failing
dumps can never prune a good one out from under a future rollback).

## After a `CRITICAL` alert

`CRITICAL` means the script gave up rather than guess: it has already tried to
restore the previous release (tree, dependencies, images, host config) and
either that failed too, or the failure was in the restore path itself. Either
way, **the services are stopped, deliberately** — `clan-wars-bot`, `web` and
`ingest-worker`. This is not a partial outage to route around; it is the
script refusing to leave a half-restored host looking fine while it silently
serves a mismatched version (spec §4: a stopped host is a visible outage a
human fixes, which is strictly better than a deploy loop thrashing against a
database it cannot read — that thrashing is exactly how the 2026-09-01
duplicate-DM incident would reach a real player again, automated).

To recover:

1. Read the alert. It names the dump it was trying to restore from
   (`Dump: /var/backups/clan-wars/predeploy-<tag>-<timestamp>.sql.gz`) and the
   step that failed.
2. Establish `factions_live`'s actual state before touching anything — it may
   already be correctly restored, mid-restore, or untouched, depending on
   which step failed. `deploy/README.md`'s "Restoring" section has the
   scratch-database comparison sequence; use it here rather than guessing.
3. If a restore from the named dump is still needed, run it by hand — the
   same drop/recreate/`psql -v ON_ERROR_STOP=1` sequence `rollback()` uses is
   in `deploy/deploy-release.sh`'s `rollback()` function, read it rather than
   retype it from memory.
4. Once the database, tree and images agree with each other, start the
   services by hand, in the order the script itself uses and for the same
   reason — `web`/`ingest-worker` first, confirm they're healthy, **the bot
   last**: `notifyCompleted` DMs a player before it marks the DM sent, so
   starting the bot against a database state it has already ticked past
   reproduces the 2026-09-01 duplicate-DM incident.

       sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
       sudo -n docker compose up -d web ingest-worker
       # confirm: docker compose ps postgres, curl -fsS http://127.0.0.1:3020/
       sudo systemctl start clan-wars-bot
       journalctl -u clan-wars-bot -n 50 --no-pager   # look for "bot ready as"

5. Find and fix the underlying cause before letting the timer near this tag
   again — a `CRITICAL` never fixes itself.

### The `FAILED-<tag>` marker

A **non-`CRITICAL`** failure — the ordinary "this release is broken" case,
where the automatic rollback succeeded and the previous release is back up
and healthy — still leaves a marker at `/var/lib/clan-wars/deployed-tag.failed`,
containing the tag that failed. ⚠️ This is deliberate, not a bug: without it,
the timer would see the same newest tag again in two minutes and repeat the
entire stop/dump/migrate/start outage for the same broken release, every two
minutes, forever. The script refuses to retry a tag while this marker names
it — the alert says `BLOCKED`, not `CRITICAL`, because production is fine;
only the retry is refused.

To let it retry (normally: after a fix has been pushed and re-tagged, or once
you've confirmed the earlier failure was transient):

    sudo -u acab rm /var/lib/clan-wars/deployed-tag.failed

A healthy deploy of the *same* tag clears this marker itself on success — you
only ever need to remove it by hand after a failure that will not resolve on
its own, or to force a documented retry of a tag you've decided is actually
fine.
