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
