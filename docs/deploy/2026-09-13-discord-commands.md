# Deploy: Discord slash commands (plan 1 — link and base)

No migration. Nothing in this deploy touches `factions_live`'s schema.

⚠️ **This deploy adds a new workspace package, `@factions/copy`, and `apps/bot`
imports it.** The bot is not containerised — it runs from the host's checkout and
the host's `node_modules` — so `git pull` alone leaves `@factions/copy` unlinked
and the bot dies at startup with `Cannot find package '@factions/copy'`.
`pnpm install` between the pull and the start is not optional here, and it is the
one step that makes this deploy different from every previous bot deploy.
`deploy-web.sh` does **not** run it: the web image is built by Docker, whose
`Dockerfile` does `COPY packages` + `pnpm install --frozen-lockfile` and so picks
the package up on its own.

## Order

1. **Web.** `ssh acab@regime.fi /opt/clan-wars/deploy/deploy-web.sh`
   It pulls, rebuilds and restarts the `web` container, then reconciles the field
   guide into Discord. The web change is copy imports only (`apps/web/lib/*-copy.ts`
   now re-export `@factions/copy`), so it is independent of the bot and may go
   before or after.
2. **Stop the bot.** `sudo systemctl stop clan-wars-bot`
   ⚠️ Never `pkill -f "src/main.ts"` on this host — ~15 dayzonelife.com services
   match that pattern. The unit's cgroup is the only safe stop.
3. **Pull and link.** `cd /opt/clan-wars && git pull --ff-only && pnpm install`
   (Step 1 already pulled; the pull here is a no-op when web went first. The
   `pnpm install` is not.)
4. **Start the bot.** `sudo systemctl start clan-wars-bot`
   Registration is `Routes.applicationGuildCommands` at boot and replaces the whole
   command list in ONE PUT, so `/link` and `/base` appear and the `/link` retired
   stub disappears at the same instant.
5. **Confirm it is actually up**, not merely `active (running)`:
   `journalctl -u clan-wars-bot -n 40 --no-pager`
   ⚠️ `active (running)` answers only "how many processes", never "is the data path
   alive" — the bot holds no eager database connection and every tick is
   individually try/caught, so one pointed at a dead database runs happily with
   everything broken. Look for the ready line and the absence of a registration
   failure; `systemctl status` alone is not evidence.

## Acceptance

- `/link status` as an unlinked account: the card says to run `/link start`.
- `/link start` autocompletes on a gamertag the log has seen, and the reply shows
  the emote sequence.
- ⚠️ Confirm the reply is **ephemeral** — only you can see it. A public
  challenge sequence is a challenge anyone in the channel can perform: they
  read your emote sequence off the screen and bind their own character UID to
  your Discord account before you do.
- `/link cancel`, then `/link status`: no open challenge.
- `/base show` as a linked, clanless account.
- `/base declare` autocompletes only poles that account raised at.
- `/faction`, `/whoami`, `/unlink` still answer with the site pointer — they are
  removed in plan 3, not here.

## Rollback

There is no image to roll back; the bot runs from the checkout.

    sudo systemctl stop clan-wars-bot
    cd /opt/clan-wars && git checkout 9fedf7c && pnpm install
    sudo systemctl start clan-wars-bot

The old `buildCommands()` PUT restores the previous command list, `/link` stub
included. Nothing this deploy writes is unreadable by the old bot — no migration,
no new column, no new row shape.

⚠️ `pnpm install` on the way back too: the old tree has no `@factions/copy`, and a
stale link to a package that is no longer in `pnpm-workspace.yaml` is its own
startup failure.

⚠️ Rolling the checkout back moves `deploy/nginx/` with it — those paths are
symlinked from `/etc/nginx/`. `9fedf7c` postdates that directory so this is safe,
but a rollback to anything older takes nginx's config off disk for all four sites
on this host. See `deploy/README.md`.
