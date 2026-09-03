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

⚠️ Before checking out any branch or commit on this host, know that you are editing live
nginx configuration. After any checkout, run `sudo nginx -t`. If you need to work on an
old commit, use a git worktree elsewhere rather than moving this one.
