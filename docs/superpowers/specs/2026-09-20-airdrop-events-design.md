# Airdrop events — design

**Status:** proposed 2026-09-20, amended 2026-09-21, not implemented.

Sixteen locations on Livonia have a staged locked-container spawner, in three
colours each (`livonia/custom/airdrop-<location>-<colour>.json`, 48 files).
Today exactly one of them is live, hand-enabled in `cfggameplay.json`, and it
survives every restart until someone edits it back out.

This makes the drop an event: the bot picks a location and a colour, announces
it before a restart, enables it for exactly one two-hour session, and takes it
away again. It fires at most twice a week, and only when the server is
genuinely busy.

---

## 1. Scope

In scope: one new tick, one new table, one file splice, one Discord message,
one addition to the in-game restart warning.

Out of scope, deliberately:

- **The key economy.** The four `ShippingContainerKeys_*` types stay exactly as
  they are (§3.4). This feature does not get a vote on how keys circulate.
- **What is in the container.** Since `959f556` the three
  `Land_ContainerLocked_*_DE` groups are gone from `mapgroupproto.xml`, so the
  containers draw no central-economy loot at all: a drop is furnished entirely
  by its own `custom/airdrop-*.json`. Editing those 48 files is somebody else's
  job. This feature decides *where* and *when*, never *what*.
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
UTC at 0.52. The trigger in §3.1 never fires near it, and nothing else needs
that fact any more: an earlier draft scheduled a daily file reconciliation
there, which §6 has replaced with per-slot recomputation costing nothing.

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

On the first tick at or after T-30min before a restart slot, fire when **all**
hold:

    pop >= max(AIRDROP_MIN_POP, p90 of slot pops over the trailing 14 days)
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

The `max(floor, p90)` shape is doing two jobs. The floor stops the event firing on
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
`restart-tick.ts` owns *enable* and *disable*, in the same position and with
the same discipline as the existing `applyTruckWipe` and `applyRaidWindow` —
and, per §5, sharing the latter's single read-modify-write of the file.

## 5. The file edit

`WorldsData.objectSpawnersArr` in `cfggameplay.json` gains or loses one
element, `./custom/airdrop-<location>-<colour>.json`.

A targeted splice, never a parse-and-reserialize, and with the same
refuse-rather-than-guess guards `setBaseDamageDisabled` already carries: parse
first to prove the input is valid, then match elements whose path contains
`/airdrop-`, and throw unless exactly zero or one matches. Parse the result
back and confirm the array holds what was intended — the second guard
`setBaseDamageDisabled` documents, for the same reason: parsing proves the file
is loadable, and only reading the value back proves the edit did what it meant
to. This is the file whose corruption stops the server *booting*, for every
player. Refusing to write costs one event; writing a broken file costs the
server.

⚠️ **One read-modify-write per slot, shared with the raid flip.** The airdrop
and the raid window edit the same file on the same slot, and two independent
download/upload pairs mean whichever uploads second silently discards the
other's edit — a weekend that never opens, or a drop that never lands, with
every guard above passing and nothing logged. `applyRaidWindow` already
downloads `cfggameplay.json` every slot, so `restart-tick.ts` downloads it
once, applies `setBaseDamageDisabled` and then `setAirdropSpawner` to that one
string, and uploads once if either changed. The two features keep their own
rows, their own alerts and their own failure semantics; they share exactly one
HTTP round trip.

⚠️ There is no `mapgrouppos.xml` edit, and adding one would be a regression.
An earlier draft of this design had the bot rewriting a marked region of that
705,058-byte file to place the container's nine CE loot points. `959f556`
removed the `Land_ContainerLocked_*_DE` groups from `mapgroupproto.xml`
altogether, so a `mapgrouppos` entry at those coordinates now builds no group,
dispatches no proxies and spawns no loot — it would be 705KB of risk for no
effect.

## 6. Level-triggered, and it costs nothing

`applyTruckWipe` and `applyRaidWindow` are level-triggered on file *content*:
every slot downloads the file and recomputes the wanted state, so a lost or
hand-reverted write is corrected within two hours. The airdrop inherits that
property for free, because §5 has it riding on a download the raid flip was
making anyway: the wanted spawner state is recomputed from the database's
intent every slot, and any drift is corrected at the next one.

That matters more here than it looks, because of a clobber this design does not
otherwise control. The `livonia` repo *is* the mission tree, and publishing a
GitHub Release FTPs the whole tree — `cfggameplay.json` included — over
whatever the bot has written (`livonia/CLAUDE.md`). The repo's baseline carries
no airdrop spawner, so a Release published during a live drop removes it early.
The next slot puts it back if the event is still running, and never strands one
on after it has ended, because both directions are recomputed from the row. A
drop cut short by a deploy is the accepted cost, not a bug to engineer around;
the same hazard already applies to the raid window's `disableBaseDamage`.
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
  retries — §6's recomputation is the retry, not a separate mechanism. Players
  were told "after the restart" and it slipped, so a short follow-up goes out.
  After two failures it scrubs: row `failed`, budget refunded, one plain notice.
- **Disable fails.** Retried every slot until confirmed, with no give-up, and
  an ops alert after the second failure. The asymmetry with enable is the
  point: a failed enable costs one event, while a failed disable leaves a
  locked container standing at a grid square every player knows, for as long as
  it takes someone to notice.
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

Three pure functions carry every decision, each testable against fixtures cut
from the real files:

    setAirdropSpawner(json, spec | null)   -> { json, changed }
    chooseAirdrop(recentLocations, rng)    -> spec
    shouldFire(pop, history, weekCount, lastFire, now) -> boolean

The guard cases matter more than the happy paths: a `cfggameplay.json` that
does not parse, one whose `objectSpawnersArr` is missing or is not an array,
two `/airdrop-` entries where there should be one, and an edit that parses but
leaves the array holding something other than what was asked for. Every one of
them must throw rather than write.

One composition test belongs beside them, because §5's shared round trip is the
part that is easy to get wrong later: a single slot that both flips the raid
window and enables a drop must produce one upload carrying both edits.

The tick itself uses the existing fake-Nitrado pattern from
`restart-tick.test.ts`.

## 12. Rollout

1. Confirm the mechanic on the live server with `airdrop-dolnik-blue`
   hand-enabled, as it is today: the container and its 29 props spawn, and the
   container opens to the matching key. Nothing below is worth building if the
   mechanic does not work.
2. Revert `cfggameplay.json` in the `livonia` repo to the baseline with no
   `airdrop-*` spawner registered, so the bot owns the state rather than
   inheriting a hand-set one — and so a Release never re-enables a drop the
   bot has ended (§6).
3. Ship with `AIRDROP_WEEKLY_CAP=1` for the first fortnight, then raise to 2.