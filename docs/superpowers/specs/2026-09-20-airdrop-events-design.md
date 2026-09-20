# Airdrop events — design

**Status:** proposed 2026-09-20, not implemented.

Sixteen locations on Livonia have a staged locked-container spawner, in three
colours each (`livonia/custom/<location>-airdrop-<colour>.json`, 48 files).
Today exactly one of them is live, hand-enabled in `cfggameplay.json` and
`mapgrouppos.xml`, and it survives every restart until someone edits it back
out.

This makes the drop an event: the bot picks a location and a colour, announces
it before a restart, enables it for exactly one two-hour session, and takes it
away again. It fires at most twice a week, and only when the server is
genuinely busy.

---

## 1. Scope

In scope: one new tick, one new table, two file splices, one Discord message,
one addition to the in-game restart warning.

Out of scope, deliberately:

- **The key economy.** The four `ShippingContainerKeys_*` types stay exactly as
  they are (§3.4). This feature does not get a vote on how keys circulate.
- **The loot tables.** What is inside a container is `cfgspawnabletypes.xml`'s
  business. This feature decides *where* and *when*, never *what*.
- **New locations or colours.** The 48 staged files are the menu.
- **Forecasting beyond one session.** The horizon is deliberately short; §3.2
  is why that is enough.
- **Anything that can delay or cancel a restart.** See §9.

## 2. What the data says

Measured against `factions_live` on 2026-09-20: 2,707 sessions since
2026-09-01 on one active server, concurrency reconstructed from
`player_sessions` at 10-minute resolution.

**The population is small and growing.** Daily mean concurrency ran 1.18 on
09-13 and 3.77 on 09-20; daily peaks ran 5 and 13 over the same stretch. Any
rule written against an absolute constant today will be wrong in a quarter.

**The day has a hard shape.** 18:00–04:00 UTC averages about 3.3 concurrent;
09:00–13:00 UTC averages about 0.3. The quietest slot on the server is 12:00
UTC at 0.52, which is why §6 reconciles there.

**The obvious trigger does not work.** "Current pop exceeds the trailing 24h
mean" fires at 72 of 167 restart slots, about five times a day. It also fires
for the wrong reason: on 09-09 00:00 it fired with **one** player online,
because a dead morning had dragged the mean to 0.88. A rolling mean rewards
quiet periods, which is precisely backwards.

Adding an absolute floor does nearly all the useful work:

| rule | fires/day |
|---|---|
| `cur > avg24` | 5.1 |
| `cur > avg24 && cur >= 3` | 3.9 |
| `cur > avg24 && cur >= 4` | 3.0 |
| `cur > avg24 && cur >= 5` | 1.9 |
| `cur >= avg24 * 1.5 && cur >= 4` | 2.3 |
| `cur >= 24h peak && cur >= 4` | 0.14 |

**Population persists across a restart.** This is the finding the whole design
rests on. Correlation between concurrency 10 minutes *before* a restart and 30
minutes *after* it is **r = 0.817** over 239 slots. When 4+ are on beforehand,
the mean afterwards is 4.62 against a server-wide mean of 1.51, and 82% of the
time at least 3 players are back. Players rejoin. Current population is
therefore a good forecast of next session's population, and no model is needed.

## 3. The trigger

### 3.1 The rule

At roughly T-30min before a restart slot, fire when **all** hold:

    pop >= max(5, p90 of slot pops over the trailing 7 days)
    drops already this ISO week < AIRDROP_WEEKLY_CAP
    at least 24h since the last drop
    nothing currently announced or live

Simulated over the last 14 days this fires four times in two weeks, every one
at a real peak:

| fired | pop at decision | pop 30m after restart |
|---|---|---|
| Tue 09-08 20:00 | 6 | 5 |
| Sat 09-12 02:00 | 6 | 5 |
| Mon 09-14 02:00 | 7 | 4 |
| Tue 09-15 02:00 | 11 | 7 |

The `max(5, p90)` shape is doing two jobs. The floor stops the event firing on
a week that has no good moment in it. The percentile raises the bar by itself
as the server grows, so the constant does not need re-tuning.

### 3.2 The budget is a cap, never a quota

⚠️ A quota — "spend two per week, always" — produces duds, and this is
measured, not theoretical. A trailing-percentile threshold with a must-spend
quota fired on Tue 09-08 at **2** players online, and 30 minutes after that
restart the server was empty. The threshold had collapsed to 2.0 because the
preceding week was quiet, and the quota insisted on spending anyway.

A dead week has no good moment in it. It gets zero drops, and that is correct
behaviour, not a failure to be engineered around.

### 3.3 Picking the drop

Location: uniform random across the 16, excluding the last 5 used. Colour:
uniform random across the three.

Base proximity is deliberately **not** a factor. The declared bases are far
enough away that it is a mild home-field advantage rather than a raid magnet:
the tightest pairs today are Nadbor at 942m from Z2, Gliniska at 1,296m from
SNA, and Dolnik at 1,397m from the admin castle. Everything else is 2km+.
Weighting against them would make 3 of 16 locations rare in exchange for very
little, and the weighting would go stale every time a base moves.

The no-repeat window exists only so the same location does not come up twice
running, which reads as a bug to players even when it is fair.

### 3.4 Only the location is announced

Players are told *where*, never *which colour*. The colour is the gamble.

⚠️ This is a real cost and it was accepted knowingly. Keys are scarce: all
four `ShippingContainerKeys_*` types are `nominal 0`, `min 0`, `restock 0` in
`db/types.xml`, so they never enter through the loot economy at all. The only
sources are the convoy officer attachment at roughly 0.33 per colour
(`cfgspawnabletypes.xml:5151-5156`) and the single blue key placed in the
admin castle. Ground lifetime is 1800s, so an unlooted key is gone in half an
hour.

So a clan can win the fight at Dolnik holding an orange key and open nothing.
That is the intent: holding a full set of keys becomes a standing strategic
asset, and whoever has the right one becomes the target.

## 4. Lifecycle

Four states, keyed on the restart slot the drop goes live at.

    decide   T-30min before a slot. Row written `announced`, Discord posted.
    enable   at the slot, before the restart POST. Row -> `live`.
    disable  at the next slot, two hours later. Row -> `ended`.

The drop is live for exactly one session. `airdrop-tick.ts` owns *decide*;
`restart-tick.ts` owns *enable* and *disable*, calling `applyAirdrop` in the
same position and with the same discipline as the existing `applyTruckWipe`
and `applyRaidWindow`.

## 5. The two file edits

### 5.1 cfggameplay.json

`WorldsData.objectSpawnersArr` gains or loses one element,
`./custom/<location>-airdrop-<colour>.json`.

A targeted splice, never a parse-and-reserialize, and with the same
refuse-rather-than-guess guards `setBaseDamageDisabled` already carries: parse
first to prove the input is valid, then match elements containing
`-airdrop-`, and throw unless exactly zero or one matches. This is the file
whose corruption stops the server *booting*, for every player. Refusing to
write costs one event; writing a broken file costs the server.

### 5.2 mapgrouppos.xml

⚠️ Pre-registering all 16 locations permanently and leaving them there does
not work, and it is worth writing down why, because it is the obvious
shortcut. `mapgroupproto.xml:155` gives `Land_ContainerLocked_Blue_DE`
`lootmax="9"` with its loot points at y = -1.087. A `mapgrouppos` entry spawns
those nine weapons whether or not the physical container from the object
spawner is there. Sixteen permanent entries means fifteen caches of free
military loot spawning under the terrain across the map.

So the file is edited per event. It is 705,058 bytes across 5,291 lines and it
drives loot for the entire map, so the bot never writes it freehand. A marker
pair is added **by hand, once**, immediately after `<map>`:

    <!-- AIRDROP BEGIN (bot-owned, do not hand-edit) -->
    <!-- AIRDROP END -->

The bot rewrites only the bytes between them, and refuses to write at all
unless it finds exactly one BEGIN and exactly one END, in that order.
Everything outside comes back byte-identical. The bot never creates the
markers: a missing marker pair is a misconfiguration to be reported, not a
condition to be repaired by a process that is holding a 705KB file it did not
write.

## 6. Why mapgrouppos is not level-triggered on file content

`applyTruckWipe` and `applyRaidWindow` are level-triggered on file *content*:
they download every slot and recompute the wanted state, so a lost or
hand-reverted write is corrected within two hours. That property is worth
keeping and the reasoning behind it is sound.

Applied literally to mapgrouppos it means pulling 705KB twelve times a day,
8.5MB/day, to learn that nothing changed on eleven of them.

This design level-triggers on **database intent** instead. The file is touched
only on the enable and disable transitions, and the transition is retried every
slot until the upload is confirmed — so a failed disable keeps trying rather
than leaving a container standing. Full reconciliation, downloading both files
and comparing against intent, runs once a day at the 12:00 UTC slot, the
quietest on the server (§2).

The property that is given up: a hand-edit to the marker region is corrected
within a day rather than within two hours. That is an acceptable trade for a
region the bot owns and no human is expected to touch.

## 7. The state table

Per-server keyed, following `server_restarts` rather than
`vehicle_wipe_announcements`, because a drop is a file on one mission and two
servers would each need their own.

    airdrop_events
      server_id        integer     not null references servers(id)
      slot_at          timestamptz not null   -- the slot it goes live at
      location         text        not null
      colour           text        not null   -- blue | orange | yellow
      decided_at       timestamptz not null
      pop_at_decision  integer     not null
      threshold        numeric     not null
      state            text        not null   -- announced | live | ended | failed
      announced_at     timestamptz
      ended_at         timestamptz
      detail           jsonb       not null default '{}'
      primary key (server_id, slot_at)

`threshold` is stored rather than recomputed, for the same reason
`vehicle_wipe_announcements.event_name` is stored: the row records what was
decided at the time. Recomputing it later against a grown population would
make the record lie about why the event fired.

## 8. Announcement

Discord's own timestamp markup gives the countdown for free.
`<t:1758412800:R>` renders as a live "in 32 minutes" that counts down by
itself, in each viewer's own timezone, with no message editing and no repost.

One message, at decision time, to `SERVER_EVENTS_CHANNEL_ID`:

> **Airdrop inbound: Dolnik**
> A locked container drops at Dolnik when the server comes back up, <t:X:R>.
> We are not saying which colour. Bring your keys.
> It is gone at the restart after that.

The in-game restart warning carries it too, since that reaches everyone who is
not in Discord. `RESTART_MESSAGE` is currently the constant
`"Scheduled restart"`; when a drop is scheduled for that slot it becomes
`"Scheduled restart. Airdrop at Dolnik next session."`

## 9. Failure handling

⚠️ **If the announcement fails to post, the drop is not enabled.** This falls
directly out of §3.4: with only the location announced and no in-world marker,
nobody would ever find an unannounced container. A silent airdrop is strictly
worse than no airdrop, because it spends a week's budget on nothing. The row
goes `failed` and the budget is refunded.

- **Enable fails at the slot.** The row stays `announced` and the next slot
  retries; players were told "after the restart" and it slipped, so a short
  follow-up goes out. After two failures it scrubs: row `failed`, budget
  refunded, one plain notice.
- **Disable fails.** Retried every slot until confirmed, with no give-up, and
  an ops alert after the second failure. The asymmetry with enable is the
  point: a failed enable costs one event, while a failed disable leaves
  high-tier loot respawning at a grid square every player knows.
- **Nothing here ever blocks the restart.** The whole block sits in the same
  outer try/catch as the truck wipe and the raid flip. Players rely on the
  two-hour cadence far more than they rely on any of this, and the next slot
  recomputes the wanted state anyway.

## 10. Config

    AIRDROP_TICK=on
    SERVER_EVENTS_CHANNEL_ID=...
    AIRDROP_WEEKLY_CAP=2
    AIRDROP_MIN_POP=5

`SERVER_EVENTS_CHANNEL_ID` is **fatal** when the tick is on and it is unset,
following the precedent `RAID_WINDOW_TICK` sets for
`ANNOUNCEMENTS_CHANNEL_ID`: the feature is player-facing, so having nowhere to
post is misconfigured, not merely degraded. §9 makes this doubly true, since
a drop that cannot be announced is a drop that does not happen.

## 11. Testing

Four pure functions carry every decision, each testable against fixtures cut
from the real files:

    setAirdropSpawner(json, spec | null)   -> { json, changed }
    setAirdropGroup(xml, spec | null)      -> { xml, changed }
    chooseAirdrop(recentLocations, rng)    -> spec
    shouldFire(pop, history, weekCount, lastFire, now) -> boolean

The guard cases matter more than the happy paths: absent markers, duplicate
markers, markers out of order, a `cfggameplay.json` that does not parse, two
`-airdrop-` entries where there should be one. Every one of them must throw
rather than write.

The tick itself uses the existing fake-Nitrado pattern from
`restart-tick.test.ts`.

## 12. Rollout

1. Let the current restart run with `dolnik-airdrop-blue` hand-enabled.
   Confirm the container spawns and the nine loot points actually dispatch.
   Nothing below is worth building if the mechanic does not work.
2. Revert `cfggameplay.json` and `mapgrouppos.xml` to the empty baseline and
   add the marker pair (§5.2), so the bot owns the state rather than
   inheriting a hand-set one.
3. Ship with `AIRDROP_WEEKLY_CAP=1` for the first fortnight, then raise to 2.
