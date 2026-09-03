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

The systemd units have the SAME property — `/etc/systemd/system/clan-wars-bot.service`
and the two backup units are symlinks into this tree. Editing them in the repo changes
the live unit, and systemd notices only on `daemon-reload`. This already happened once:
a review fix touched the bot unit's comments, and the next `systemctl restart` warned
that the unit file had changed on disk. The running service kept the OLD definition until
`daemon-reload` — so an edit you believe is deployed may not be.

⚠️ Before checking out any branch or commit on this host, know that you are editing live
nginx and systemd configuration. After any checkout, run `sudo nginx -t` and
`sudo systemctl daemon-reload`. If you need to work on an old commit, use a git worktree
elsewhere rather than moving this one.

## Backups

`factions_live` is dumped nightly by `clan-wars-backup.timer` (04:17 UTC, `Persistent=true`,
5-minute jitter) to `/var/backups/clan-wars/`, gzipped, 14 kept.

⚠️ This is a LOCAL backup. It protects against a bad migration, a dropped table or a
wrong `DELETE`. It does **not** survive losing the machine — and losing the machine is
what happened to the previous deployment of this project.

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
