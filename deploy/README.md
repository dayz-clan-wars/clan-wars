# deploy/

Host configuration for `regime`, the machine running this stack. These files
are the source of truth; `/etc/nginx/sites-enabled/` and `/etc/systemd/system/`
hold symlinks to them.

⚠️ This nginx serves three other production sites (dayzonelife.com,
manicdotes.com, regime.fi). Run `sudo nginx -t` before every reload, and
`reload`, never `restart`.

## Install

    sudo ln -s /opt/clan-wars/deploy/nginx/00-default-server.conf \
      /etc/nginx/conf.d/00-default-server.conf
    sudo ln -s /opt/clan-wars/deploy/nginx/dayzclanwars.com.conf \
      /etc/nginx/sites-enabled/dayzclanwars.com
    sudo nginx -t && sudo systemctl reload nginx

    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-bot.service \
      /etc/systemd/system/clan-wars-bot.service
    sudo systemctl daemon-reload && sudo systemctl enable --now clan-wars-bot

⚠️ The vhost references `/etc/letsencrypt/live/dayzclanwars.com/`. Install it
only after that certificate exists — `nginx -t` fails on a missing
`ssl_certificate` path, and a failing test blocks reloads for every site here.

## Install — the release deployer

`deploy/deploy-release.sh` polls for a new release tag and deploys it end to
end (preflight, outage window, health check, automatic rollback). Spec:
`docs/superpowers/specs/2026-09-16-auto-deploy-design.md`.

⚠️ **Do not enable `clan-wars-deploy.timer` until the rollback rehearsals in
the plan have been run.** `rollback()` has never executed against this host —
until it has been exercised deliberately once, it is a design, not a proven
capability, and enabling the timer makes an unrehearsed rollback a production
event, triggered by whatever the first bad release happens to be.

1. **Create the state directory, owned by `acab`.** The script runs as `acab`
   (see the service unit below) and writes two files under `/var/lib/clan-wars`:
   the deployed-tag state file, on every successful deploy, and a failure
   marker, on every failed one. If the directory is root-owned, both writes
   fail — and the state-file failure is the serious one, because it happens
   *after* a successful deploy, so the tag is never recorded, and the next
   poll two minutes later redeploys the same tag over and over: a permanent
   redeploy loop, each iteration a full production outage. The script alerts
   instead of dying when this happens, but the loop itself remains until the
   directory's ownership is fixed. A future operator who recreates this
   directory as root (e.g. `sudo mkdir /var/lib/clan-wars`) reintroduces the
   loop.

       sudo install -d -o acab -g acab /var/lib/clan-wars

   **And the backup directory, for the same reason.** The deployer writes its
   pre-deploy dump to `/var/backups/clan-wars`, which the nightly backup unit
   (`clan-wars-backup.service`, no `User=`) creates **root-owned** — so on a
   host where the nightly backup ran first, `acab`'s dump fails with EACCES.
   That failure is recoverable (it aborts before the migration, restores and
   alerts `CRITICAL`), but it happens inside the outage window and it will fail
   rehearsal 1:

       sudo install -d -o acab -g acab /var/backups/clan-wars

   ⚠️ `install -d` on an existing directory resets its ownership, which is what
   is wanted here: root can still write to a directory owned by `acab`, so the
   nightly backup is unaffected, while the deployer gains the access it needs.

2. **Seed the state file with the tag currently live**, run as `acab` so it
   matches the directory's ownership from step 1 (substitute the real tag —
   `pnpm deploy:select` prints it):

       echo v1.15.0 | sudo -u acab tee /var/lib/clan-wars/deployed-tag

   Skipping this makes the first run deploy the newest tag over whatever is
   actually live, with no comparison to catch it.

3. **Add `DEPLOY_WEBHOOK_URL` to `/opt/clan-wars/.env`.** Create a Discord
   webhook in the ops channel (Channel Settings → Integrations → Webhooks) and
   append `DEPLOY_WEBHOOK_URL=<url>` to the file. ⚠️ Never commit it — `.env`
   is gitignored and has never been in this repo's history. The alert path is
   deliberately independent of the bot: the bot is stopped for most of a
   deploy and may be the thing that failed, so it cannot also be the thing
   that reports the failure.

4. **Run a dry run on the host, by hand, before enabling the timer.** This is
   the first point at which the script can run end to end at all — it cannot
   complete on a developer machine: no `flock` binary contention to model, no
   `/home/acab/.local/bin/pnpm`, and its `stat -c` usage is GNU-only (macOS's
   `stat` takes different flags). Do not treat this as optional or skip
   straight to enabling the timer:

       cd /opt/clan-wars && ./deploy/deploy-release.sh --dry-run

   Expect a `DRY:`-prefixed line per command it would have run, and no
   mutation. Read it before going further.

5. **Install the units:**

       sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.service \
         /etc/systemd/system/clan-wars-deploy.service
       sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.timer \
         /etc/systemd/system/clan-wars-deploy.timer
       sudo systemctl daemon-reload

   ⚠️ **`daemon-reload` only — do not `enable --now` the timer here.** This
   step installs the units; enabling the timer is a separate decision, taken in
   `docs/deploy/2026-09-16-auto-deploy.md`, and only once its step 0
   prerequisites and step 2 dry run have passed and someone is at a terminal
   ready to run its step 4 rehearsals and watch them. Enabling it from here —
   four lines under the ⚠️ above saying the rollback has never executed on this
   host — makes an unrehearsed `rollback()`, which drops and recreates
   `factions_live`, a production event triggered by whatever release happens to
   fail first.

⚠️ The deploy state lives at `/var/lib/clan-wars/deployed-tag`, deliberately
outside this tree: a file inside it would be rewritten by the deploy's own
`git checkout`, so a rollback would restore a file claiming the rollback never
happened.

### Verify the units install without arming the timer

    sudo systemctl cat clan-wars-deploy.timer
    systemd-analyze verify /etc/systemd/system/clan-wars-deploy.{service,timer}

⚠️ The timer is not enabled at this point (step 5 stopped at
`daemon-reload` on purpose), so `systemctl list-timers clan-wars-deploy` shows
nothing and `journalctl -u clan-wars-deploy` is empty — that emptiness is
expected here, not a fault, and is not the thing to fix by enabling the timer.
`systemctl cat` confirms the symlink resolves to the real unit file;
`systemd-analyze verify` (where available) checks both unit files for syntax
errors without starting anything.

## Operating the bot

    systemctl status clan-wars-bot     # includes the cgroup: the real instance count
    sudo systemctl stop clan-wars-bot
    journalctl -u clan-wars-bot -f

⚠️ Never `pkill -f "src/main.ts"` on this host. See the unit file's comment.

## ⚠️ These symlinks point into a git working tree

`/etc/nginx/sites-enabled/dayzclanwars.com` and `/etc/nginx/conf.d/00-default-server.conf`
are symlinks into `/opt/clan-wars/deploy/nginx/`, which is a checked-out git tree. So a
branch switch, a `git stash`, or a checkout of any commit predating this directory makes
the nginx configuration **vanish from disk** while nginx is still running.

Nothing fails at that moment — a running nginx holds its config in memory. The failure
comes at the next `nginx -t` or reload, and the blast radius is every site on this host,
not just this one:

- `systemctl reload nginx` fails, leaving the OLD config live. Recoverable.
- `systemctl restart nginx`, or a reboot, leaves nginx **down for all sites**.
- `certbot.timer` runs daily and reloads nginx after a renewal. That is the realistic
  way this bites: unattended, at 11:03, days after the checkout that caused it.

The systemd units have the SAME property — `/etc/systemd/system/clan-wars-bot.service`,
the two backup units, and the two deploy-timer units (`clan-wars-deploy.service`,
`clan-wars-deploy.timer`) are all symlinks into this tree. Editing them in the repo
changes the live unit, and systemd notices only on `daemon-reload`. This already
happened once: a review fix touched the bot unit's comments, and the next `systemctl
restart` warned that the unit file had changed on disk. The running service kept the
OLD definition until `daemon-reload` — so an edit you believe is deployed may not be.

⚠️ Before checking out any branch or commit on this host, know that you are editing live
nginx and systemd configuration. After any checkout, run `sudo nginx -t` and
`sudo systemctl daemon-reload`. If you need to work on an old commit, use a git worktree
elsewhere rather than moving this one.

## Backups

`factions_live` is dumped nightly by `clan-wars-backup.timer` (04:17 UTC, `Persistent=true`,
5-minute jitter) to `/var/backups/clan-wars/`, gzipped, 14 kept.

This is a LOCAL backup, and it is the second of two layers: the host itself takes daily
snapshots, which is what covers losing the machine. The two are not redundant. A snapshot
restores the whole machine and is crash-consistent — restoring one is equivalent to
pulling the power cord, which Postgres recovers from by replaying WAL at startup (safe
here because the data lives in a single Docker volume; the hazard case is a data
directory spread across volumes snapshotted at different moments). What a snapshot cannot
do is give you one table back, or let you inspect a dump without touching production, or
restore into a different Postgres version. That is what these dumps are for, and the
failures they cover — a bad migration, a dropped table, a wrong `DELETE` — are the ones
that actually happen.

⚠️ What is unrecoverable without it: `events` can be re-ingested from Nitrado's ADM logs,
but `factions`, `faction_members`, `identity_links` and `faction_events` cannot. Losing
them means every player redoes `/link`, every roster is gone, and the feed's history is
gone permanently — a transition's own evidence IS the log, so nothing can reconstruct it.

The script refuses to rotate if the dump fails its integrity check or comes back
implausibly small, because rotation that runs regardless would delete 14 good backups
over 14 nights of a silently failing dump.

### Restoring

⚠️ Restore into a SCRATCH database first and compare it against production before you
consider replacing anything. This exact sequence was run on 2026-09-03 and the restored
copy matched production on migrations, servers, events and table count.

    LATEST=$(ls -1t /var/backups/clan-wars/factions_live-*.sql.gz | head -1)
    docker exec clan-wars-postgres-1 psql -U factions -d factions -X \
      -c "create database restore_probe"
    gzip -dc "$LATEST" | docker exec -i clan-wars-postgres-1 \
      psql -U factions -d restore_probe -X -q
    docker exec clan-wars-postgres-1 psql -U factions -d restore_probe -X -c "
      select (select count(*) from drizzle.__drizzle_migrations) as migrations,
             (select count(*) from servers) as servers,
             (select count(*) from events) as events"

To restore for real, stop the bot first (`sudo systemctl stop clan-wars-bot`) — old code
against a restored older schema is the hazard CLAUDE.md describes — then drop and recreate
`factions_live` from the dump, and start the bot again.

### Checking it is still working

    systemctl list-timers clan-wars-backup
    journalctl -u clan-wars-backup -n 20
    ls -lt /var/backups/clan-wars/ | head

⚠️ A timer that is armed is not a backup that is running. Check the newest file's date,
not the timer's existence.
