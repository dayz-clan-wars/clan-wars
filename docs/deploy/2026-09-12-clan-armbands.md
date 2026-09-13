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

A full member of a clan gets their clan's armband attached to the `Armband` slot
whenever their character reaches the world with that slot empty:

- a **fresh spawn** (new character on first join),
- a **respawn after death**,
- a **reconnect** with their existing saved character.

That third one is what covers a player who joined a clan while already alive: they
reconnect and the band appears.

It fills an **empty slot only**. A player who takes their band off, or who is wearing a
captured enemy band, is left alone until the next time they arrive with the slot empty
- so this stays a spawn gift, not enforcement, and armband deception still works.

Not covered, by design:

- **Pending members get nothing.** `status = 'full'` only (spec 4.5, 14) - a pending
  member has accepted but has not been seen at the clan's base.
- **A clan whose texture is outside the 34-flag pool gets nothing.** `armbandFor()`
  returns null rather than inventing `Armband_<something>` that does not exist.

---

## Why three hooks, not one

DayZ splits "a character reached the world" across three `MissionServer` events, and
hooking one covers only one of the three ways it happens:

| Event | Fires when |
|---|---|
| `PlayerBase OnClientNewEvent(PlayerIdentity, vector, ParamsReadContext)` | a character is created on connect |
| `void OnClientRespawnEvent(PlayerIdentity, PlayerBase)` | a new character after death |
| `void OnClientReadyEvent(PlayerIdentity, PlayerBase)` | an existing saved character is loaded |

All three call `CW_GiveArmband`, and each calls `super` first - the spawn preset equips
inside `super`, so running before it would test an `Armband` slot the preset has not
filled yet.

### The two dead ends

**`StartingEquipSetup` and `EquipCharacter` never run on this server.**
`cfggameplay.json` sets `spawnGearPresetFiles: ["./custom/loadout.json"]`, and vanilla
`OnClientNewEvent` (DayZ 1.29) does:

```c
if (CreateCharacter(identity, pos, ctx, presetCharType) != null)
{
    PlayerSpawnHandler.ProcessEquipmentData(m_player, presetData);
    return m_player;                     // <- returns HERE
}
...
EquipCharacter(g_Game.GetMenuDefaultCharacterData());   // never reached
```

`EquipCharacter` is the only caller of `StartingEquipSetup`. That is why the
`StartingEquipSetup` body in the original `init.c` (bandage + chemlight) has no effect
today - those items come from `custom/loadout.json` instead.

**`OnStoreLoad` cannot be hooked.** It is a `PlayerBase` method, so reaching it would
need a modded `PlayerBase` class, and console DayZ allows no mods. `OnClientReadyEvent`
is `MissionServer`'s equivalent moment and is overridable from `init.c`.

### WARNING: this bit was got wrong once

The first version (2026-09-13, reverted) hooked `OnClientNewEvent` alone. A player
committed suicide at 21:20:07, respawned at 21:20:27 with no armband, and the script log
showed a clean compile and no errors - because a respawn fires `OnClientRespawnEvent`,
which was not hooked. The failure was completely silent. Hence the `Print` on every
branch, below.

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

### 5. Verify from the script log

This is the step that matters. After the restart, read the newest `script_*.log` in the
server's config directory and confirm:

- `Module: $CurrentDir:mpmissions\dayzOffline.enoch\init.c; loaded 1x files; 1x classes`
- no `Compile error` lines near it
- a `[CLANWARS]` line for each connect/respawn

WARNING: **the log is buffered.** Nitrado's file server does not show a running session's
log until it flushes, which in practice is when the session ends. Ten minutes after a
restart the directory can still show nothing newer than the PREVIOUS session, and that is
normal - it is NOT evidence that the mission failed to load. On 2026-09-13 that was read
as a boot failure and it was wrong. To read a session's log promptly, restart again and
read it after it flushes, or check the `.ADM` (which flushes more often) for player
events.

The `[CLANWARS]` lines say exactly what happened:

```
[CLANWARS] OnClientRespawnEvent
[CLANWARS] uid=89B9... attached Armband_Rooster
```

and on the paths that do nothing:

```
[CLANWARS] uid=... not in any clan, no armband
[CLANWARS] uid=... already wearing an armband, leaving it
[CLANWARS] uid=... FAILED to attach Armband_Rooster
```

An absent `[CLANWARS]` line for a spawn that definitely happened means the hook did not
fire - check which of the three events that spawn should have used.

Then have a linked player die and respawn, and confirm the band is on.

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

- **Nothing verifies the generated file compiled.** The bot uploads and restarts; if the
  mission failed to load, the next slot's `status()` reports something other than
  `started` and records `skipped`, but nothing names `init.c` as the cause. Step 5 is a
  human check, once, at deploy.
- **A player who removes their band gets it back on next reconnect.** Accepted: it is
  the price of covering the player who joined a clan while alive. Wearing any other
  armband still blocks it, so deception plays are unaffected.
- **The `[CLANWARS]` prints are permanent.** They cost one line per connect in a log
  nobody reads by default, and they are the only thing standing between a silent no-op
  and a diagnosable one. Do not remove them to tidy the log.
