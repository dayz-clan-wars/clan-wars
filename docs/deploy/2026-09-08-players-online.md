# Players online — deploy runbook

No migration. The bot keeps ONE message in `#players-online` (Feeds, id
`1546928156902949016`) edited to the open `player_sessions`: who is on, their clan tag now,
and how long they have been on, longest first. "Nobody on the server." when empty.

1. **Set `PLAYERS_ONLINE_CHANNEL_ID`** in the host `.env`. Off by default, like every feed.

2. **Pull and restart the bot**: `git pull && sudo systemctl restart clan-wars-bot`. On its
   first tick the bot looks for its own newest message in the channel and edits it; with none
   it sends one. Nothing to seed.

3. **Verify**: one embed in the channel, and `players online: N shown` in the journal. The
   message is re-edited only when someone connects, disconnects, reconnects or changes clan
   — not every tick. Deleting the message is safe: the next change sends a fresh one.

⚠️ "Online" is the log's word, at the log's latency (the ingest sweep plus Nitrado's file
updates). A server restart without disconnect lines shows players until the sessions
consumer closes their rows at the ADM file boundary.
