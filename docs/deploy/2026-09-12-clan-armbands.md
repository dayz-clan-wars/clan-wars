# Per-clan spawn armbands (2026-09-12)

Every full member of a clan spawns wearing that clan's armband. The bot renders the
whole of the mission's `init.c` from the roster and uploads it before each scheduled
restart, so the armband table matches who is actually in which clan.

No migration. One new env var. **One ownership change that has to land in both repos.**

---

## ⚠️ Read this first

**The bot becomes the only writer of `init.c`.** Before this change the file shipped
from the `livonia` repo on every GitHub Release. Both writing it is not possible: the
Release would clobber the generated table, and the bot would overwrite the Release at
the next slot. So `init.c` is now in `deploy.yml`'s exclude list.

⚠️ **Both halves must ship together.** If the bot is enabled while `livonia` still
deploys `init.c`, every Release silently reverts the armbands until the next restart
slot. If `livonia` excludes it but the bot is off, `init.c` is frozen at whatever is on
the server right now — which is fine, but nothing updates it again.

**The mission script now lives in `apps/bot/src/init-c.ts`,** not in the `livonia`
repo. The copy at `livonia/init.c` is a reference only; editing it changes nothing.

---

## What it does in game

On a **fresh spawn** — a new character after death, or a first join — a full member of
a clan gets their clan's armband attached to the `Armband` slot, on top of whatever the
spawn preset gave them. It is then an ordinary item: they can take it off, or wear a
captured enemy band. Nothing re-applies it.

Not covered, by design:

- **A player who joins a clan while alive gets their armband on next death,** not
  immediately. `OnClientNewEvent` only fires on a fresh spawn.
- **Pending members get nothing.** `status = 'full'` only (spec §4.5, §14) — a pending
  member has accepted but has not been seen at the clan's base.
- **A clan whose texture is outside the 34-flag pool gets nothing.** `armbandFor()`
  returns null rather than inventing `Armband_<something>` that does not exist.

---

## Why the hook is `OnClientNewEvent`

The obvious places do not work on this server, and both fail *silently*.

`cfggameplay.json` sets `spawnGearPresetFiles: ["./custom/loadout.json"]`. Vanilla
`OnClientNewEvent` (DayZ 1.29, `scripts/5_mission/mission/missionserver.c`) does:

```c
if (CreateCharacter(identity, pos, ctx, presetCharType) != null)
{
    PlayerSpawnHandler.ProcessEquipmentData(m_player, presetData);
    return m_player;                     // <- returns HERE
}
...
EquipCharacter(g_Game.GetMenuDefaultCharacterData());   // never reached
```

and `EquipCharacter` is the only caller of `StartingEquipSetup`. With a valid preset
both are dead code — which is why the `StartingEquipSetup` body already in the server's
`init.c` (bandage + chemlight) has no effect today: those items come from
`custom/loadout.json` instead.

So the armband is attached in an `OnClientNewEvent` override, after `super` has run.

## Why the generated part is only string literals

A syntax error in `init.c` stops the mission loading, on a file the bot rewrites
unattended every two hours. So codegen is confined to the arms of one lookup function:

```c
if (uid == "75E109C8…") return "Armband_Bear";
```

Every id is checked against `^[0-9A-F]{40}$` and every classname against
`^Armband_[A-Za-z0-9_]+$` before it is emitted; a row failing either is dropped and
logged, never emitted. Everything else in the file is fixed text. The arms are sorted by
id so an unchanged roster renders byte-identically and is not re-uploaded.

---

## Deploy

### 1. `livonia` — stop deploying `init.c`

Already committed on `main`: `init.c` is first in `deploy.yml`'s exclude list, and
`CLAUDE.md` records who owns the file now.

⚠️ This takes effect at the **next Release**, not on merge (`deploy.yml` triggers only
on `release: [published]` — see `livonia/CLAUDE.md`). No Release is needed *for* this
change; it just has to be true before the next one.

### 2. Confirm the current `init.c`, and keep a copy

```sh
# through the bot's own credentials
TOKEN=$(grep -m1 '^NITRADO_TOKEN=' .env | cut -d= -f2-)
DIR=/games/ni11558038_4/ftproot/dayzxb_missions/dayzOffline.enoch
URL=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.nitrado.net/services/19831378/gameservers/file_server/download?file=$DIR%2Finit.c" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"]["url"])')
curl -s "$URL" -o /tmp/init.c.before
```

Keep `/tmp/init.c.before` somewhere real. It is the rollback.

### 3. Turn it on

In `.env`:

```
CLAN_ARMBANDS=1
```

⚠️ Requires `RESTART_SCHEDULE=1`. Config load fails with a named error if it is off,
because the write only ever happens on a restart slot.

⚠️ Put it in `.env`, not on the start command line. The same trap as
`BOT_FEED_CHANNEL_ID`: a command-line-only value turns the feature off at the next
restart with nothing saying so.

```sh
sudo systemctl restart clan-wars-bot
systemctl status clan-wars-bot          # one process, active (running)
```

Startup logs one of:

```
clan armbands on: init.c is rewritten from the roster before each restart.
CLAN_ARMBANDS is off: clan spawn armbands are not being written to init.c.
```

### 4. Watch the first slot

At the next even UTC hour:

```
restart: server 1 wrote init.c for 2026-09-12T14:00:00Z
restart: server 1 restarted for 2026-09-12T14:00:00Z
```

The `wrote init.c` line appears only when the file actually changed — the first slot
always, later slots only when the roster moved.

### 5. Verify the server compiled it

This is the step that matters, and the one that catches a broken file. After the
restart, read the newest `script_*.log` from the server's config directory and confirm:

- `Module: $CurrentDir:mpmissions\dayzOffline.enoch\init.c; loaded 1x files; 1x classes`
- no `Compile error` / `Bad init.c` lines near it

Then have one linked player die and respawn, and confirm the armband is on.

---

## Rollback

Turn `CLAN_ARMBANDS` off, restart the bot, and put the old file back:

```sh
RESP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"path\":\"$DIR\",\"file\":\"init.c\"}" \
  https://api.nitrado.net/services/19831378/gameservers/file_server/upload)
U=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"]["url"])')
T=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["token"]["token"])')
curl -s -X POST -H "Content-Type: application/binary" -H "token: $T" \
  --data-binary @/tmp/init.c.before "$U"
```

The file is read at boot, so the restore takes effect at the next restart.

To hand ownership back to the `livonia` repo, also remove `init.c` from `deploy.yml`'s
exclude list and publish a Release.

---

## Known-open

- **A player who joins a clan while alive waits for their next death.** Accepted: the
  alternative is a recurring script timer touching every player, in a file whose syntax
  error costs the server its mission.
- **Nothing verifies the generated file compiled.** The bot uploads and restarts; if the
  mission failed to load, the next slot's `status()` reports something other than
  `started` and records `skipped`, but nothing names `init.c` as the cause. Step 5 above
  is a human check, once, at deploy.
