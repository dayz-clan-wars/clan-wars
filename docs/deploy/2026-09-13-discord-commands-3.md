# Deploy: Discord slash commands (plan 3 — vault, map, reads)

No migration. Nothing in this deploy touches `factions_live`'s schema.

⚠️ **Tell players before you deploy this.** Registration is one PUT at boot and
replaces the whole command list, instantly and totally, for every player the
moment the bot restarts. The retired stubs `/unlink`, `/whoami` and `/faction`
**stop existing** in that instant — not "replies differently," gone. A player
who types `/whoami` today gets a pointer to the site; after this deploy they
get Discord client's own cached "unknown command," and once that cache
refreshes, nothing at all: the command is no longer offered anywhere. Nine new
commands (`/vault`, `/map`, `/scoreboard`, `/alphas`, `/seasons`, `/warlog`,
`/player`, `/board`, `/achievements`) appear in the same PUT, the same
instant. Say so in the clan channels before this deploy, not after — there is
no transition period and no way to make one.

## Order

Unchanged from plan 2, and for the same reasons.

1. **Stop the bot.** `sudo systemctl stop clan-wars-bot`
   ⚠️ Never `pkill -f "src/main.ts"` on this host — ~15 dayzonelife.com services
   match that pattern. The unit's cgroup is the only safe stop.
2. **Pull.** `cd /opt/clan-wars && git pull --ff-only`
3. **Install.** ⚠️ `pnpm` is not on the non-interactive ssh PATH on this host.
   Plan 2's deploy hit `pnpm: command not found` with the bot already stopped,
   and plan 2's own runbook says bare `pnpm install` — that line was wrong;
   this is the correction. The unit file names the real path:

       /home/acab/.local/bin/pnpm install

   Run it with the full path, not bare `pnpm install`.
4. **Start the bot.** `sudo systemctl start clan-wars-bot`
   Registration is `Routes.applicationGuildCommands` at boot and replaces the
   whole command list in ONE PUT: the nine new commands appear and
   `/unlink`, `/whoami`, `/faction` disappear, at the same instant.
5. **Confirm it is actually up**, not merely `active (running)`:

       journalctl -u clan-wars-bot -n 40 --no-pager

   ⚠️ `active (running)` is not evidence the bot works. It holds no eager
   database connection and every tick is individually try/caught, so a bot
   pointed at a dead database runs happily with `systemctl status` reporting
   healthy while every command fails. Look for the ready line in the journal;
   `systemctl status` alone proves nothing.

**The web build is unaffected, even though the diff is not `apps/bot`-only.**
`apps/web/lib/{scoring,stats,achievements}-copy.ts` and `packages/copy` both
changed on this branch — the copy those files held moved into the shared
`@factions/copy` package so the bot's new cards could reuse the site's exact
wording. The moved values are byte-identical, and the web files that used to
define them now just re-export from `@factions/copy`, so the site renders
exactly what it rendered before. There is no reason to redeploy or rebuild
`web` for this change — do not run `deploy-web.sh` for it.

## Acceptance

See `docs/acceptance/2026-09-13-discord-commands-3.md`.

## Rollback

There is no image to roll back; the bot runs from the checkout.

    sudo systemctl stop clan-wars-bot
    cd /opt/clan-wars && git checkout <previous sha>
    /home/acab/.local/bin/pnpm install
    sudo systemctl start clan-wars-bot

The old `buildCommands()` PUT restores the previous command list, retired
stubs included. Nothing this deploy writes is unreadable by the old bot — no
migration, no new column, no new row shape.
