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
| `BOT_DORMANT_AFTER_MS` | no (default `604800000`, 7 days) | How long without a member raising the clan's flag at its pole before the clan goes dormant. Default from `packages/domain/src/rules.ts` (`DORMANT_AFTER_MS`). Plain decimal digits only. |
| `BOT_DISBAND_AFTER_DORMANT_MS` | no (default `1209600000`, 14 days) | How long a clan stays dormant before it is disbanded. Default from `packages/domain/src/rules.ts` (`DISBAND_AFTER_DORMANT_MS`). Plain decimal digits only. |
| `BOT_FEED_CHANNEL_ID` | no (unset means the feed is off) | The Discord channel id the faction feed posts embeds to. Unset by default: `faction_events` rows still accumulate, nothing posts. The bot needs **View Channel, Send Messages and Embed Links** in that channel — without Embed Links every post fails and blocks the queue at that row. |
| `WAR_LOG_CHANNEL_ID` | no (unset means the war log is off) | The Discord channel id `#war-log` posts to — raids, defenses, and (later) week and season closes (`war_log_events`, spec §9.2). Unset by default: rows still accumulate, nothing posts. The bot needs **View Channel and Send Messages** in that channel. |
| `FLAG_IMAGE_BASE_URL` | no (unset means embeds post without a thumbnail) | An absolute http(s) URL — a bare origin, no path, query string or fragment — that `apps/web` serves the 33 flag images from. Set, the feed's resolver returns `<base>/flags/<texture>.png` for each embed's thumbnail; unset or empty, it returns `null` and embeds post exactly as they do today. Use `https://dayzclanwars.com`; a trailing slash is tolerated and stripped. The bot never fetches this URL to check it — a wrong value costs a missing thumbnail, nothing more. |
| `SITE_BASE_URL` | no (default `https://dayzclanwars.com`) | Bare origin of the site. Every retired slash command and the ceremony DM point players here. |
| `CLAN_TEXT_CATEGORY_ID` | yes | The Discord category id the bot creates clan text channels in. Right-click the category with Developer Mode enabled to copy it. |
| `CLAN_VOICE_CATEGORY_ID` | yes | The Discord category id the bot creates clan voice channels in. Right-click the category with Developer Mode enabled to copy it. |
| `LINKED_ROLE_ID` | yes | The Discord role id the bot uses for the @Linked role. Right-click the role with Developer Mode enabled to copy it. |
| `ALPHA_ROLE_ID` | yes | The Discord role id the bot uses for the @Alpha role. Right-click the role with Developer Mode enabled to copy it. |

Example `.env` (placeholders only — never commit real values):

```
DISCORD_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=000000000000000000
DISCORD_GUILD_ID=000000000000000000
DATABASE_URL=postgres://factions:factions@localhost:5434/factions_live
BOT_TICK_INTERVAL_MS=10000
BOT_DORMANT_AFTER_MS=604800000
BOT_DISBAND_AFTER_DORMANT_MS=1209600000
BOT_FEED_CHANNEL_ID=1234567890123456789
WAR_LOG_CHANNEL_ID=1234567890123456789
FLAG_IMAGE_BASE_URL=https://dayzclanwars.com
SITE_BASE_URL=https://dayzclanwars.com
CLAN_TEXT_CATEGORY_ID=12345678901234567
CLAN_VOICE_CATEGORY_ID=22345678901234567
LINKED_ROLE_ID=32345678901234567
ALPHA_ROLE_ID=42345678901234567
```

`BOT_FEED_CHANNEL_ID` above is a placeholder — replace it with your own
channel's real id (Developer Mode → right-click the channel → Copy Channel
ID). A run of zeros will not do: real snowflakes never start with a zero, and
the config loader rejects one at startup rather than let it pass validation
and block the feed queue at the first post.

## Creating the Discord application and inviting the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, add a bot user and copy its token into `DISCORD_TOKEN`. Under **General Information**, copy the application (client) ID into `DISCORD_APPLICATION_ID`.
3. Under **OAuth2 → URL Generator**, select both the `bot` and `applications.commands` scopes. The `bot` scope is what lets the bot join a server and send messages/DMs; `applications.commands` is what lets it register and respond to slash commands.
4. Under **Bot Permissions**, at minimum select "Send Messages" (used for the notification fallback when a player's DMs are closed) and "Manage Nicknames" (used to set a player's server nickname to their gamertag once `/link` verifies — not needed for linking itself, only for the rename, so linking still works if this is left off, just without the nickname change). Discord will never let a bot rename the server owner, no matter what permission it holds; that rename attempt always fails, and it's reported to the player as such.
5. Open the generated URL, pick the target server, and authorize. Copy that server's ID into `DISCORD_GUILD_ID`.

## Permissions and intents

The bot needs **Manage Roles, Manage Channels, and Manage Nicknames** permissions guild-wide to create and manage clan roles and channels, and to rename members. Enable the **Server Members Intent** on the Developer Portal → Bot page; the gateway will refuse to connect without it once the intent is requested. The bot's own role must sit **above** every clan role it creates — Discord places new roles at the bottom by default, so this holds unless you manually reorder roles after the bot runs. The bot's role must also sit above `@Alpha`, since it assigns and removes that role at each week's close.

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

This registers `/link`, `/unlink`, `/whoami` and `/faction` as bare, retired
commands — each answers with one line pointing at the site (spec §9.1) —
plus `/guest`, which is the one live command: an officer or the leader runs
it in their clan's own text channel to give someone a 24h voice guest pass
(`guest-command.ts`, backed by the roster's `grantGuestPassDb`) — logs in,
and starts the tick loops on `BOT_TICK_INTERVAL_MS`. Each tick is
skipped rather than overlapped if the previous one is still running — the
tick reads and writes a shared cursor, and two overlapping runs could
otherwise move that cursor backwards.

Outside the tick loop, the gateway's `guildMemberRemove` event is handled as
it arrives (`guild-removal.ts`): the guide's "being removed from the
Discord removes you from everything" (spec §5.4). The handler first checks
the event's guild id against `DISCORD_GUILD_ID` — a mismatch writes nothing
— and only then calls the roster's `removeFromGuildDb`, which in one
transaction drops the roster row, the identity link, any solo declaration,
and any guest pass the user held, handing the seat to a successor (or
disbanding the clan) if the departed player was its leader. There is no
catch-up sweep for removals that happened while the bot was down (ruling
10) — this is a gateway-event handler only.

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

The presence tick promotes a pending member on the first log line that
places them within 50 m of their clan's base (the guide's number lives in
`rules.ts`); the pending-expiry sweep removes a pending member unseen for 7
days. Right after presence, `leadership-tick.ts` runs spec §7's leadership
clock every tick (ruling 13, a 60 s ceiling rather than a throttle): a
succession claim past its `resolves_at` hands the seat to the claimant or is
voided, and a no-confidence vote past its `closes_at` passes or fails —
`resolveSuccessionClaims` and `closeExpiredVotes`, both from the roster's
internal store. Before presence runs, `membership-tick.ts` reconciles the membership
history (spec §11 ⚠️): it diffs the current full members against the open
rows of `membership_history` and writes only the differences — a new member
opens a span, a missing one closes it at that tick's `now`. This must run
before presence (so it sees the roster before promotions) and before the kills
consumer (which uses `membershipAt` to resolve faction membership at the
instant each kill happened).

Each tick also runs the map's two consumers, right after presence and before
the structure tick: `positions-tick.ts` projects every `pos`-bearing event
into `player_positions` (the map's "last fix" per player), then
`zone-tick.ts` reads the same events to raise or drop intruder sightings and
notice their owners — positions before zones, so a sighting's own dot has
already landed by the time it can alert anyone. After zone, `sessions-tick.ts`
and `kills-tick.ts` run the event consumers for player sessions and kills
(spec §4.9, §11): `sessions-tick.ts` opens a `player_sessions` row on each
`player.connected` event and closes it on `player.disconnected`, an ADM file
boundary (the server restarted without a clean disconnect line — there is no
`player.restart` event type), or a duplicate connect; the three outcomes are
reported as `sessions: N opened, M closed, R restarted`, where `restarted`
covers both of the latter two; `kills-tick.ts`
opens a `kills` row for each `player.killed` or `player.died` event, resolving
the victim and killer's clan membership at that instant via `membershipAt`.
Alongside the pending-expiry sweep, `reaper-tick.ts` runs the map's half of
the reaper (expired pins, stale positions, sightings with no recent fix),
throttled to once every five minutes rather than every tick. Since increment
7 it also deletes guest passes that are past `expires_at`, or that were
revoked/converted more than five minutes ago — the delay leaves a
revoked/converted row in place long enough for the structure tick's own
diff (below) to see it and remove the matching voice overwrite before the
row disappears out from under it.

`structure-tick.ts`'s reconciler (right before the structure summary line
below) gained two more steps since increment 7, run in this order after its
existing role/channel/`@Linked`/`@Alpha` diffs: step 7 reconciles each clan
voice channel's guest-pass overwrites — an open pass whose user is now a
full member is converted first (`convertGuestPasses`, so its access rides
the clan role from then on and its overwrite becomes a stray for the same
diff to remove), then the remaining open passes are diffed against the
channel's actual member overwrites (`guild.memberOverwrites`, which excludes
the bot's own View+Connect grant on that channel so the diff never revokes
it) and only the difference is granted or revoked; a failed pass read is
gated out of the diff entirely (`guestReadOk`) so it under-acts rather than
reading "no open passes" and revoking every guest overwrite in the guild.
Step 8 sets `[TAG] gamertag`/bare-gamertag nicknames (`nicknameFor` in
`packages/domain/src/leadership.ts`, both forms capped at Discord's 32-char
limit) for every still-linked user whose current nickname (read from the
member cache, so a manual rename is caught within one tick interval at zero
REST cost when nothing actually changed) does not already match — disjoint
from step 5, which only ever clears a nickname for a user LEAVING the link
set.

Each tick also runs the raid and raise consumers (`raid-tick.ts`,
`raise-tick.ts`) — every `flag.lowered`/`flag.raised` event that scores a
raid, records a defense, revives a dormant clan, or notices a non-member
raise, colors-elsewhere, or a rebind proposal — followed by the two posters
that turn those consumers' queued rows into Discord messages: `war-log-tick.ts`
posts `war_log_events` rows to `#war-log` (spec §9.2, gated on
`WAR_LOG_CHANNEL_ID` the same way the feed is gated on `BOT_FEED_CHANNEL_ID`)
and `notice-tick.ts` posts `clan_notices` rows — a clan channel message or a
DM, rendered by `notice-text.ts` (spec §9.3/§9.4) — always, since a DM needs
no channel configuration at all. A `clan_notices` row that fails three times
is marked failed and stops being retried; a row behind it for the SAME
target waits only for the current tick, and posts on the next one once the
failing target is no longer blocking it.
