# Booster kits — deploy runbook

A Discord server booster picks nine clothing pieces on the website (`/kit`), then
performs a short emote sequence in game where they want the kit to spawn. A bot tick
witnesses the emotes (`kit-placement-tick.ts`) and records the spot on their
`booster_kits` row. Every ingest sweep, `booster-kit-tick.ts` regenerates
`booster-kits.json` — one spawner entry per eligible booster's nine items plus their
clan's armband, if any — hashes it, and uploads it through Nitrado only when the hash
changed. The kit reappears at every server restart, the same mechanism the faction
supplies file already uses. When someone stops boosting they drop out of the query
(`discord_boosters` is an inner join) and the kit stops appearing at the next restart —
nothing deletes anything.

Migration `0043_easy_toro.sql` adds four tables, additive only — nothing dropped, nothing
altered: `booster_kits` (one row per booster, the nine slots plus a placed position),
`discord_boosters` (mirrored from the guild by `boosterTick` in the bot), `booster_kit_uploads`
(the hash/baseline the worker's upload dedupe reads, same shape as `supply_uploads` and
`travel_uploads`) and `booster_kit_challenges` (the open emote-sequence challenge issued
from the picker, closed by the bot's witnessing tick).

## Order of operations

1. **Apply migration `0043_easy_toro.sql`.** Four new tables only — every statement is
   `CREATE TABLE IF NOT EXISTS` or `CREATE INDEX/CONSTRAINT IF NOT EXISTS` against those
   new tables. Nothing existing is touched, so the bot and ingest worker may keep running
   while it applies. Use the runner from `docs/deploy/2026-09-14-db-migrate.md`.

2. **Deploy the bot and the ingest worker.** No feature flag gates either half. The bot's
   `boosterTick` (interval `BOOSTER_TICK_INTERVAL_MS`, default 15 minutes — see
   `apps/bot/README.md`) starts mirroring guild boosters into `discord_boosters`
   immediately, and `kit-placement-tick.ts` starts watching for completed emote
   sequences. The worker's `boosterKitTick` is wired unconditionally in
   `apps/ingest-worker/src/main.ts`, right after the supplies and travel ticks, so it
   starts regenerating and (when the hash changes) uploading `booster-kits.json` on its
   very next sweep. No env var or config switch turns this wiring on; it is on as soon as
   the worker is running the new build.

3. **Confirm `booster-kits.json` appears in the mission's `custom` directory after one
   sweep**, beside `faction-supplies.json` (`NitradoClient.missionCustomDir()`, the same
   directory `raid-window.md`'s manual procedure opens for `cfggameplay.json`). Check the
   worker's log for `booster kit file uploaded for server <id>: <n> kits`, or list the
   directory through the Nitrado panel. **It will contain exactly `{"Objects":[]}`** until
   at least one booster has placed a kit — that is correct, not a failure. Nobody has
   completed the in-game emote sequence yet at this point in the rollout, so an empty
   `Objects` array is exactly what a working pipeline produces.

   Steps 1 to 3 are safe to deploy and safe to leave indefinitely. The game server does
   not read `booster-kits.json` unless something tells it to — see below — so until that
   happens the worker is uploading a file the server ignores. There is no rush to do step
   4 the same day; nothing breaks and nothing is exposed by deploying only this far.

4. **The manual step.** ⚠️ Nothing in this codebase writes `cfggameplay.json`, deliberately —
   see the same warning in `docs/deploy/raid-window.md`: a bad automated write to a file
   the server parses at boot breaks the map for everyone. Through the Nitrado panel (*Tools*
   → *File Browser* → the mission directory → `cfggameplay.json`), add
   `"./custom/booster-kits.json"` to `WorldsData.objectSpawnersArr`, next to the existing
   entry for the supplies file. Change nothing else in the file — no reformatting, no
   trailing comma. Copy the file's content first, before editing, exactly as
   `raid-window.md`'s manual procedure does — that copy is the only recovery path if the
   edit leaves the JSON invalid, and an invalid `cfggameplay.json` fails the server to
   start for everyone. Read the file back after saving and confirm it still parses (the
   panel's editor flags a JSON error if not; when in doubt, paste it into
   `python3 -m json.tool` locally) and that the new entry is there.

5. **Restart the server** from the panel, and confirm a placed kit appears. If no booster
   has placed a kit yet, this step only confirms the spawner entry itself did not break
   anything (still `{"Objects":[]}`, server starts clean); ask a booster to run the emote
   sequence to get an end-to-end confirmation, then restart once more and check their nine
   items and clan armband (if any) are on the ground where they stood.

## Rollback

Remove the `./custom/booster-kits.json` entry from `WorldsData.objectSpawnersArr` in
`cfggameplay.json` (same manual, by-hand edit as step 4, copy the file first) and restart.
The bot and worker can keep running — nothing about them needs to stop or be flagged off.
`booster-kits.json` keeps being regenerated and uploaded every sweep exactly as before;
the server simply goes back to ignoring it, the same state steps 1–3 leave things in.
Nothing already placed in game is removed by this — items already spawned stay until the
next restart re-places the mission's spawners without that entry.
