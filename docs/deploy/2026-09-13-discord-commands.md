# Deploy: Discord slash commands (plan 1 — link and base)

No migration. Nothing in this deploy touches `factions_live`'s schema.

## Order

1. Deploy `apps/web` (copy imports only — `apps/web/lib/*-copy.ts` now re-export
   `@factions/copy`). Independent of the bot; may go before or after.
2. Stop `clan-wars-bot`.
3. Deploy the bot image.
4. Start the bot. Registration is `Routes.applicationGuildCommands` at boot and
   replaces the whole command list in ONE PUT, so `/link` and `/base` appear and
   the `/link` retired stub disappears at the same instant.

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

Redeploy the previous bot image. Its `buildCommands()` PUT restores the old list,
including the `/link` stub. Nothing was written that the old bot cannot read.
