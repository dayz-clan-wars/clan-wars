# @factions/bot

The Discord bot that links a player's Discord account to their in-game DayZ
character (UID) via an in-game emote challenge, and reports back once the
in-game verification tick confirms it.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | The bot user's token, from the Discord Developer Portal → Bot page. Treat it as a secret; never commit it. |
| `DISCORD_APPLICATION_ID` | yes | The application (client) ID, from the Developer Portal → General Information page. |
| `DISCORD_GUILD_ID` | yes | The Discord server (guild) ID the bot's slash commands are registered to. Right-click the server icon with Developer Mode enabled to copy it. |
| `DATABASE_URL` | yes | Postgres connection string for the `@factions/db` schema (identity links, verification challenges, event log). ⚠️ Use `factions_live`, not `factions`: the test suites truncate `factions`, and the bot must read the same event log the ingest worker writes or `/link` will never see a player's emotes. |
| `BOT_TICK_INTERVAL_MS` | no (default `10000`) | How often the verification tick scans new emote events, in milliseconds. Plain decimal digits only. |
| `BOT_CHALLENGE_TTL_MS` | no (default `86400000`) | How long an issued `/link` challenge stays live before it expires. 24 hours by default, matching one-life; safe because a challenge names the one character that can satisfy it. Plain decimal digits only. |
| `BOT_RESERVATION_TTL_MS` | no (default `86400000`) | How long a `/faction claim` reservation holds a flag, tag and pole before it can be reclaimed. Plain decimal digits only. |
| `BOT_INVITE_TTL_MS` | no (default `604800000`, 7 days) | How long a `/faction invite` stays pending before it expires. Plain decimal digits only. |
| `BOT_COOLDOWN_MS` | no (default `259200000`, 3 days) | How long a kicked or departed player is barred from joining a faction on that server again. Plain decimal digits only. |
| `BOT_RENAME_COOLDOWN_MS` | no (default `604800000`, 7 days) | The minimum time between two `/faction rename`s of the same faction. Plain decimal digits only. |
| `BOT_FEED_CHANNEL_ID` | no (unset means the feed is off) | The Discord channel id the faction feed posts embeds to. Unset by default: `faction_events` rows still accumulate, nothing posts. The bot needs **View Channel, Send Messages and Embed Links** in that channel — without Embed Links every post fails and blocks the queue at that row. |

Example `.env` (placeholders only — never commit real values):

```
DISCORD_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=000000000000000000
DISCORD_GUILD_ID=000000000000000000
DATABASE_URL=postgres://factions:factions@localhost:5434/factions_live
BOT_TICK_INTERVAL_MS=10000
BOT_CHALLENGE_TTL_MS=86400000
BOT_RESERVATION_TTL_MS=86400000
BOT_INVITE_TTL_MS=604800000
BOT_COOLDOWN_MS=259200000
BOT_RENAME_COOLDOWN_MS=604800000
BOT_FEED_CHANNEL_ID=000000000000000000
```

## Creating the Discord application and inviting the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, add a bot user and copy its token into `DISCORD_TOKEN`. Under **General Information**, copy the application (client) ID into `DISCORD_APPLICATION_ID`.
3. Under **OAuth2 → URL Generator**, select both the `bot` and `applications.commands` scopes. The `bot` scope is what lets the bot join a server and send messages/DMs; `applications.commands` is what lets it register and respond to slash commands.
4. Under **Bot Permissions**, at minimum select "Send Messages" (used for the notification fallback when a player's DMs are closed) and "Manage Nicknames" (used to set a player's server nickname to their gamertag once `/link` verifies — not needed for linking itself, only for the rename, so linking still works if this is left off, just without the nickname change). Discord will never let a bot rename the server owner, no matter what permission it holds; that rename attempt always fails, and it's reported to the player as such.
5. Open the generated URL, pick the target server, and authorize. Copy that server's ID into `DISCORD_GUILD_ID`.

## Command registration is per-guild, not global

Slash commands here are registered against `DISCORD_GUILD_ID` specifically
(`Routes.applicationGuildCommands`), not globally. Guild-scoped registration
takes effect immediately, which matters during development and after any
command change. Global registration can take up to an hour to propagate to
all servers — acceptable for a bot running in exactly one server, and not
worth the wait here.

## Running

```
pnpm --filter @factions/bot start
```

This registers the `/link`, `/unlink`, and `/whoami` commands against the
configured guild, logs in, and starts the verification tick loop on
`BOT_TICK_INTERVAL_MS`. Each tick is skipped rather than overlapped if the
previous one is still running — the tick reads and writes a shared cursor,
and two overlapping runs could otherwise move that cursor backwards.

Sending `SIGTERM` or `SIGINT` (e.g. `Ctrl-C`, or a container stop) stops
future tick firings immediately and waits (up to a 15-second grace period)
for a tick already in progress to finish, before disconnecting the client and
exiting. The grace period exists so a wedged tick cannot block a container
stop forever — if it expires, shutdown proceeds without waiting further, and
that in-flight tick's transaction may be interrupted.

This single-process guard is not a distributed lock: if you ever run more
than one bot instance against the same database, add a Postgres advisory
lock keyed on the verification consumer name to serialize ticks across
processes — this codebase does not implement one.
