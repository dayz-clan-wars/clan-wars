# Deploy: Discord slash commands (plan 2 — clan administration and guest passes)

No migration. Nothing in this deploy touches `factions_live`'s schema.

No new workspace package this time, so `pnpm install` is not strictly required —
but run it anyway. The deploy that skips it is the one that breaks: `apps/bot`
runs from the host's checkout and its `node_modules`, not a built image, and
nothing here checks that the two agree before the bot starts.

⚠️ **Tell officers before you deploy this.** `/guest` changes shape: what was a
bare `/guest user:` becomes `/guest grant user:` and `/guest revoke pass:`.
Registration is one PUT at boot, so the change is instant and total for every
player the moment the bot restarts. An officer who has `/guest user:` muscle
memory and has not been warned meets a command that no longer exists in the
form they know, with nothing pointing them at the new one — say so in the clan
channels before this deploy, not after.

`/guest` also drops its channel requirement. The old `handleGuestCommand`
resolved the clan from `interaction.channelId` and refused outside a clan's own
text channel; `grantGuestPassDbFor` derives the clan from the actor's own
membership instead, so the new command works in any channel, or a DM. This is a
strictly wider surface, but the permission check underneath is unchanged — an
officer role is re-derived from `faction_members` under the clan's row lock
either way, so nothing trusts anything stale by the time the write lands.

## Order

1. **Stop the bot.** `sudo systemctl stop clan-wars-bot`
   ⚠️ Never `pkill -f "src/main.ts"` on this host — ~15 dayzonelife.com services
   match that pattern. The unit's cgroup is the only safe stop.
2. **Pull.** `cd /opt/clan-wars && git pull --ff-only`
3. **Install anyway.** `pnpm install`
4. **Start the bot.** `sudo systemctl start clan-wars-bot`
   Registration is `Routes.applicationGuildCommands` at boot and replaces the
   whole command list in ONE PUT: `/me`, `/roster`, `/clan`, `/clans`, `/lead`,
   `/found` and the reshaped `/guest` all appear, and the old bare `/guest
   user:` form is gone, at the same instant.
5. **Confirm it is actually up**, not merely `active (running)`:
   `journalctl -u clan-wars-bot -n 40 --no-pager`
   ⚠️ `active (running)` answers only "how many processes", never "is the data
   path alive" — the bot holds no eager database connection and every tick is
   individually try/caught, so one pointed at a dead database runs happily with
   everything broken. Look for the ready line; `systemctl status` alone is not
   evidence.

**Web is unaffected.** This deploy touches `apps/bot` only. Do not run
`deploy-web.sh` for it.

**Deviation from the design doc:** the command surface there writes `/me`
with a default subcommand, but Discord has no way to express a bare command
that also declares subcommands — a command is either a leaf or a router, never
both. This ships as `/me show` instead. Intentional; do not "fix" it back.

## Acceptance (needs a human in Discord)

- `/me show` on a linked account.
- `/me accept` autocompletes an open invite.
- `/roster invite` autocompletes a linked gamertag.
- `/clan info` shows your roster and your own base, and does NOT show a rebind
  candidate's pole.
- `/clan disband` shows a Confirm button and writes nothing until it is pressed.
- `/lead ballot`.
- `/found`, when a ceremony is open.
- `/guest grant user:`.
- `/guest revoke` autocompletes the clan's open passes.

⚠️ Confirm every one of these replies is **ephemeral** — only you can see it. A
clan's roster, its own base and its vault are all raid targets; a public reply
to any of these commands hands that away to anyone in the channel.

## Rollback

There is no image to roll back; the bot runs from the checkout.

    sudo systemctl stop clan-wars-bot
    cd /opt/clan-wars && git checkout <previous sha> && pnpm install
    sudo systemctl start clan-wars-bot

The old `buildCommands()` PUT restores the previous command list, bare
`/guest user:` included. Nothing this deploy writes is unreadable by the old
bot — no migration, no new column, no new row shape.
