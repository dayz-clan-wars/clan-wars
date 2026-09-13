# What we learned about `init.c` on the console server (2026-09-13)

An attempt to give every clan member their clan's armband on spawn, by rendering the
mission's `init.c` from the roster before each scheduled restart. **Deployed to CW-TEST
twice, never worked, rolled back.** Kept because most of a night went into establishing
the facts below and none of them are written down anywhere else.

The code is in git history: `ef558bd` (first attempt), `f4da08e` (re-land with three
hooks), `34a044f` (platform probes), reverted by `99efefd` and the revert that follows
`34a044f`. `livonia` carries the matching pair.

---

## The one thing that stopped us

**`Print()` produces no output from the mission `init.c` module on this console build.**

That is not proven beyond doubt, but everything points at it, and it is where the next
attempt should start.

Nothing else on the list below was ever the problem. Every "the hook ran silent"
conclusion during the investigation was worthless, because the only instrumentation was
`Print`, and `Print` writes nothing from this module. Three separate deploys were read as
"the code did not run" when the honest reading was "we cannot see whether the code ran."

### Why we believe `main()` runs

From the RPT of the probe session:

```
22:08:10.544  Module: ...dayzOffline.enoch\init.c; loaded 1x files; 1x classes
22:08:10.838  [CE][Hive] :: Initializing OFFLINE
```

`main()` in `init.c` is `Hive ce = CreateHive(); if (ce) ce.InitOffline();`, and
`[CE][Hive] :: Initializing OFFLINE` is `InitOffline()` announcing itself 0.3 s after our
module loads. A `Print("[CLANWARS] main() running")` on the first line of that same
`main()` produced nothing, in either the script log or the RPT.

So: the file compiles, the file executes, and `Print` from it is silent.

### What to instrument with instead

`GetGame().AdminLog(...)`, which writes to the `.ADM`. We have direct positive evidence
that channel works from mission script on this server - the `.ADM` recorded every
connect, suicide and respawn all night. **Start the next attempt by proving the logging
channel works before writing a line of feature code.**

---

## Facts worth keeping

### Console does compile and execute mission `init.c`

`Module: $CurrentDir:mpmissions\dayzOffline.enoch\init.c; loaded 1x files; 1x classes`
appears in every boot's script log, and `main()` demonstrably runs (above). Whatever was
"prevented" after the 2024 Bohemia ticket calling console `init.c` access a breach, it
does not block this today.

### `GetIdentity().GetId()` is the id we already store

Vanilla logout code prints `[Logout]: New player 75E109C8...` and the `.ADM` records
`Player "TIDEPRIDE113384" (id=75E109C8...)` - the same 40-hex string, which is exactly
what `identity_links.dayz_id` and `players.dayz_id` hold. No translation needed between
script and the database.

### `StartingEquipSetup` and `EquipCharacter` are dead code here

`cfggameplay.json` sets `spawnGearPresetFiles: ["./custom/loadout.json"]`, and vanilla
`OnClientNewEvent` (1.29) returns immediately after `PlayerSpawnHandler.ProcessEquipmentData`:

```c
if (CreateCharacter(identity, pos, ctx, presetCharType) != null)
{
    PlayerSpawnHandler.ProcessEquipmentData(m_player, presetData);
    return m_player;                     // <- returns HERE
}
...
EquipCharacter(g_Game.GetMenuDefaultCharacterData());   // never reached
```

`EquipCharacter` is the only caller of `StartingEquipSetup`. This is why the
`StartingEquipSetup` in the server's `init.c` (bandage + chemlight) has no effect - those
items come from `custom/loadout.json` instead, which is where someone already migrated
them.

⚠️ This was *also* misread once as evidence that the whole mission class was inert. It is
not; it is only these two methods.

### "A character reached the world" is three different events

| Event | Fires when |
|---|---|
| `PlayerBase OnClientNewEvent(PlayerIdentity, vector, ParamsReadContext)` | character created on connect |
| `void OnClientRespawnEvent(PlayerIdentity, PlayerBase)` | new character after death |
| `void OnClientReadyEvent(PlayerIdentity, PlayerBase)` | existing saved character loaded |

The first attempt hooked only `OnClientNewEvent` and covered none of a respawn. Whether
any of the three actually fire on console is **still unknown** - see the `Print` problem.

### `OnStoreLoad` cannot be hooked from `init.c`

It is a `PlayerBase` method, so it needs a modded `PlayerBase` class, and console DayZ
allows no mods. `OnClientReadyEvent` is `MissionServer`'s equivalent moment and is
overridable.

### The armband classnames are real

`Armband_Rooster` and `Armband_Wolf` are both in the server's `db/types.xml` (41
`Armband_*` entries). `armbandFor()`'s `Flag_X` -> `Armband_X` substitution is sound for
the clans that exist. Not the failure.

---

## Traps that cost real time

### Nitrado's file server does not show a running session's logs

A session's `.RPT`, `.ADM` and `script_*.log` are not visible until they flush, which in
practice is when the session **ends**. Ten minutes after a restart the config directory
can still show nothing newer than the previous session.

⚠️ This was read as "the mission failed to boot" and it was wrong. An empty log directory
after a restart is normal. To read a session's log, restart again and read it afterwards.

Worse, the *previous* session's log is still sitting there looking current, and its clean
`init.c` line will happily be mistaken for proof that the file you just uploaded
compiled. Check the filename's timestamp against the boot you care about.

### The Nitrado API and the game server disagree about "started"

`status: started` arrives well before the mission has loaded (`currentmap: None`). Waiting
on `status` alone and then concluding something about logs is a mistake. Also: polling
`until status == started` immediately after POSTing a restart exits instantly, because the
status has not flipped to `restarting` yet.

### The database on the dev machine is not production

The local `factions_live` had 1 clan; the real one on `regime` had 2 clans and 8 full
members. Check the host, not the laptop.

---

## If someone picks this up again

1. **Prove the logging channel first.** Put a single `GetGame().AdminLog("[CLANWARS] alive")`
   in `main()`, deploy, restart twice, read the `.ADM`. Write no feature code until a line
   appears. Everything after this is cheap; everything before it was guesswork.
2. Then instrument all three spawn events and confirm which actually fire on console.
3. Only then attach the armband, and log the `CreateAttachment` result.

The rest of the machinery worked and can be lifted from the reverted commits: the roster
query, the `Flag_X` -> `Armband_X` mapping, rendering the file with codegen confined to
validated string literals, CRLF + pure ASCII output, upload-only-on-change against the
live file, and hanging it off `restart-tick.ts` before the restart POST beside the truck
wipe. None of that is suspected.

⚠️ And if you re-land it: the bot becomes the sole writer of `init.c`, so `livonia` must
exclude `init.c` from its FTP deploy in the same change, or a Release will clobber the
generated file.
