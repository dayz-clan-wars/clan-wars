# Discord structure (increment 3b) — deploy runbook

No migration. The bot gains a reconciler that creates one role, one text channel and one voice
channel per active clan, deletes them at disband, gives full members the clan role and every
linked player `@Linked`, and clears the nickname of anyone who unlinks on the site. It runs once
at start and then every tick, and it only ever issues the Discord writes needed to close a
difference between the database and the guild — so a first run on a guild with N active clans
creates 3N objects and then goes quiet.

1. **Developer Portal → Bot.** Enable **Server Members Intent**. Without it the bot hangs on its
   first member fetch and every role diff sees an empty guild.
2. **Guild permissions.** The bot's role needs **Manage Roles, Manage Channels, Manage
   Nicknames** (plus the View/Send it already has for the feed). Drag the bot's role **above**
   every player role it must rename and above where clan roles will appear (new roles are
   created at the bottom, so this holds unless someone moves them).
3. **Create by hand, once:** a text category (e.g. `CLANS`), a voice category (e.g. `CLAN VOICE`),
   and a role `Linked`. Copy their ids into the bot `.env`:
       CLAN_TEXT_CATEGORY_ID=…
       CLAN_VOICE_CATEGORY_ID=…
       LINKED_ROLE_ID=…
   The bot refuses to start with any of the three missing or malformed.
4. **Deploy** the bot: `sudo systemctl restart clan-wars-bot`. The web image is unchanged by
   this increment; deploy it only if 3a's runbook has not been applied yet (do that first).
5. **Confirm on start:** `journalctl -u clan-wars-bot -f` shows `guild members fetched: N`, then
   `structure on start: created X, linkedAdds Y …` — X is the number of active/dormant clans,
   Y the number of linked players in the guild. Every existing linked player now holds
   `@Linked`; every full member holds their clan's role; each clan has `#clan-{tag}` and a
   voice channel visible only to its role.
6. **Confirm delivery:** channel notices 3a has been queueing with a null target drain in id
   order on the next notice tick:
       select count(*) from clan_notices where posted_at is null and failed_at is null and target = 'channel';
   trends to 0. A row that fails three times is `failed_at`-stamped and logged.
7. **Acceptance.** Kick a test member on the site: within a tick they lose the clan role and
   the channel shows the `kicked` line. Unlink a test account on the site (`/me`): within a
   tick `@Linked` is gone and the nickname is cleared. Disband a test clan: its channels and
   role vanish, and `factions.discord_*_id` are null. Rename a clan: role and channels follow.
8. **If someone deletes a clan channel by hand**, the bot logs `structure: missing:<id>` once
   per tick and does not recreate it (an operator's deletion is a decision). To have it
   recreated: `update factions set discord_text_channel_id = null where id = …;` — the next
   tick creates a fresh one.
9. **What waits.** `[TAG]` nickname prefixes, `@Alpha`, guest-pass overwrites and the
   guild-removal handler are increments 4 and 7.
