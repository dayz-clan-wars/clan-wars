# Deploy: the single-instance lock, and sanitised crash logs

No migration. Nothing here touches `factions_live`'s schema. `apps/bot` and
`packages/db` only — the web build is untouched, and `deploy-web.sh` is not
part of this.

## What changes operationally

**The bot now refuses to start if another one is already running against the
same database.** It takes a Postgres session-scoped advisory lock before it
opens a pool, logs in, or registers commands, and exits if it cannot have it.

⚠️ **It exits 0, not 1, and that is deliberate.** The unit is
`Restart=on-failure` and its own comment says "a bot that exits deliberately
should stay exited". Refusing because a healthy instance is already up is
deliberate, so systemd leaves it exited. Exiting non-zero would restart-loop
every `RestartSec` forever, filling the journal with a message that is in fact
the system working correctly.

So: if you start a second bot by hand, it will print one line explaining
itself and stop. That is the feature. If you want the new one to take over,
stop the old one first.

**`systemctl restart` is unaffected.** systemd waits for the stop to complete
before it starts, and the release happens after `client.destroy()`, so the
lock is free by the time the replacement asks for it.

**A SIGKILLed or power-lost bot releases the lock automatically.** The lock is
session-scoped: it dies with the connection. There is no TTL to wait out and
no stale-holder state to clear by hand — which is exactly why this is an
advisory lock rather than a row lease.

## Why it exists

Two things already depended on one-process-only and nothing enforced it:

- **The notifier is at-least-once across processes.** `notifyCompleted` sends
  the DM before `markNotified`, which is correct for one process. Two read the
  same pending list, both send, both mark. This happened for real on
  2026-09-01 — a stale process survived a `pkill` whose pattern did not match
  the expanded `tsx` command line, a second was started next to it, and a
  verified player was DM'd twice.
- **`/found` keeps its draft in memory.** A `custom_id` caps at 100 characters
  and ten participant ids do not fit, so the chosen flag and crew cannot ride
  in the interaction. Across two processes a player's select-menu pick and
  their modal submit can land on different ones, and the second answers "that
  took too long" seconds after they chose. Nothing corrupts; it just fails
  intermittently, which is the hardest kind of bug to have reported to you.

## Also here: crash logs no longer print request bodies

`unhandledRejection` and `uncaughtException` now log through `safeErrorInfo`.
Node's default handler prints an error's own enumerable properties, and both
drivers attach payloads to their errors: `@discordjs/rest` carries
`err.requestBody.json` (for `/vault reveal`, a clan's lock code) and its `url`
(an interaction token), while postgres.js carries `.query` and `.parameters`
(for `/vault add`, a submitted code). The diagnosis — name, message, code,
status — still reaches the journal.

⚠️ **The process still exits.** This sanitises the log; it does not make the
bot survive states it previously died in. If you want log-and-continue that is
a separate decision about uptime, not a logging change.

## Order

1. `sudo systemctl stop clan-wars-bot`
   ⚠️ Never `pkill -f "src/main.ts"` on this host — ~15 dayzonelife.com
   services match that pattern. The unit's cgroup is the only safe stop.
2. `cd /opt/clan-wars && git pull --ff-only`
3. `/home/acab/.local/bin/pnpm install`
   ⚠️ Full path. `pnpm` is not on the non-interactive ssh PATH.
4. `sudo systemctl start clan-wars-bot`
5. `journalctl -u clan-wars-bot -n 40 --no-pager` — look for the ready line.
   ⚠️ `active (running)` proves nothing: the bot holds no eager database
   connection and every tick is individually try/caught.

**Verifying the lock itself, on the host, after the ready line:**

    cd /opt/clan-wars && /home/acab/.local/bin/pnpm --filter @factions/bot start

It should print the refusal and exit within a second or two, leaving the
running bot untouched. That is the whole feature, checked in one command.

## Rollback

    sudo systemctl stop clan-wars-bot
    cd /opt/clan-wars && git checkout <previous sha>
    /home/acab/.local/bin/pnpm install
    sudo systemctl start clan-wars-bot

Nothing to undo beyond the checkout: no migration, and an advisory lock leaves
no rows behind.
