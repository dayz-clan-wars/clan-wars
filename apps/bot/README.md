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
| `DATABASE_URL` | yes | Postgres connection string for the `@factions/db` schema (identity links, verification challenges, event log). |
| `BOT_TICK_INTERVAL_MS` | no (default `10000`) | How often the verification tick scans new emote events, in milliseconds. Plain decimal digits only. |
| `BOT_CHALLENGE_TTL_MS` | no (default `600000`) | How long an issued `/link` challenge stays live before it expires. Plain decimal digits only. |

Example `.env` (placeholders only — never commit real values):

```
DISCORD_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=000000000000000000
DISCORD_GUILD_ID=000000000000000000
DATABASE_URL=postgres://factions:factions@localhost:5434/factions
BOT_TICK_INTERVAL_MS=10000
BOT_CHALLENGE_TTL_MS=600000
```

## Creating the Discord application and inviting the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, add a bot user and copy its token into `DISCORD_TOKEN`. Under **General Information**, copy the application (client) ID into `DISCORD_APPLICATION_ID`.
3. Under **OAuth2 → URL Generator**, select both the `bot` and `applications.commands` scopes. The `bot` scope is what lets the bot join a server and send messages/DMs; `applications.commands` is what lets it register and respond to slash commands.
4. Under **Bot Permissions**, at minimum select "Send Messages" (used for the notification fallback when a player's DMs are closed).
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
`BOT_TICK_INTERVAL_MS`. Sending `SIGTERM` or `SIGINT` (e.g. `Ctrl-C`, or a
container stop) stops the tick interval and disconnects the client before the
process exits, so a running tick isn't cut off mid-transaction.
