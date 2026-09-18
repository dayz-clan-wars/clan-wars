# Banning unlinked PC players — design

**Status:** approved 2026-09-18, not implemented.

This is one boosted PvP server on Livonia, **for Xbox**. Players on PC can and
do connect to it. This design bans a PC player who has not linked their
account, and leaves a linked one alone.

---

## 1. The signal, and where it lives

DayZ writes two log families into the same Nitrado directory. We ingest the
`.ADM` files and have never read a `.RPT`. The device type only appears in the
`.RPT`:

    17:03:01.672 [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid ) Entering AuthPlayerLoginState
    17:03:03.313  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'
    17:03:03.313  NETWORK      : Notified of player 1739924331 using device 'desktop' (not headless)
    17:03:05.31  [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid A9DDCCFAF1B79A6ADE0757193F49647B10A60913) Entering DBGetLoginTimeLoginState

Console players report `'console' (headless)`; PC players report `'desktop'
(not headless)`.

⚠️ **The device line carries a `dpnid`, not a uid, and at the moment it is
written the uid is still EMPTY.** It is filled about two seconds later. Any
implementation that tries to read a uid off the device line gets an empty
string. The join must go `dpnid` → `[StateMachine]` line → `uid` + gamertag,
within one file.

The `uid` is a 40-character uppercase hex string — the same shape and the same
value as our `identity_links.dayz_id`. Verified against live data: the uid for
`xARESx7256` in the RPT equals that player's `dayz_id` in `factions_live`.

### What a survey of the retained logs found (2026-09-18)

All 37 retained RPT files (≈3 days, the server restarts every 2 hours):

- 51 distinct players resolved
- **44 console, 7 desktop.** No account appeared as both.
- 4 device lines could not be resolved to a uid — a login that straddled a
  restart, so the `[StateMachine]` lines are in the previous file.

The seven PC players, against `factions_live`:

| gamertag | linked | in a clan | last seen |
|---|---|---|---|
| Wintershadow394 | yes, 2026-09-08 | yes | 2026-09-18 |
| YrJustBad | yes, 2026-09-09 | yes | 2026-09-16 |
| xARESx7256 | yes, 2026-09-17 | yes | 2026-09-18 |
| BLaX6619 | **no** | no | 2026-09-15 |
| FatBlunt4201955 | **no** | no | 2026-09-15 |
| Ken2715 | **no** | no | 2026-09-16 |
| Sir Alatorre | **no** | no | 2026-09-15 |

Every linked PC player is in a clan. None of the four unlinked ones is.

⚠️ **RPT retention is about three days.** "Every PC player we have ever seen"
means "since roughly 2026-09-15". A PC player who last played a week ago is
invisible to us until they next connect — at which point the rule catches them
anyway. Do not read the table above as a complete census.

---

## 2. Why the device is learned on demand, not by ingesting RPTs

The ingest worker downloads each live file **whole, every 60 seconds**, and
tracks a line cursor. ADM files are ~100 KB. RPT files grow to **2.3 MB**.
Mirroring the ADM pipeline for RPTs would pull on the order of a gigabyte a
day from Nitrado to discover, on a busy day, one new player's platform.

A device is a stable fact about an account, so it only has to be learned once.

**When a `player.connected` event arrives for an account with no
`player_devices` row, the worker fetches the current RPT once, parses it, and
upserts every sighting in it.** Every sighting, not just the one that prompted
the fetch — the file is already in hand, and the others would each cost another
fetch later. An account is looked up once, ever.

Rejected alternatives:

- **Full RPT pipeline** (second cursor, every file, every sweep): uniform with
  the ADM path, complete history, ~1 GB/day for a few bytes of signal.
- **Periodic RPT poll** (newest file every 5 minutes): still ~700 MB/day, and
  it turns "on sight" into "within five minutes" for no gain.

The chosen approach is the only one whose cost does not scale with how long the
server runs, and the only one whose failure mode is silence.

---

## 3. Components

### 3.1 `packages/adm-parser/src/device.ts` — pure

```ts
export type DeviceSighting = { dayzId: string; gamertag: string; device: "console" | "desktop" };
export function parseDevices(rpt: string): DeviceSighting[];
```

Two passes: build `dpnid → { uid, gamertag }` from `[StateMachine]` lines, then
join the `LOGINQUEUE … updated with device type 'x'` lines onto it.

It sits in `packages/adm-parser` despite parsing an RPT: it is the same log
family, from the same directory, written by the same server, and a package for
one 60-line function would be worse. The package's README says it parses the
server's logs, not only the ADM ones.

⚠️ **A device line whose `dpnid` does not resolve is DROPPED, never guessed.**
Four such lines exist in the retained logs. Not knowing a player's device must
never be a reason to ban them, so the parser emits nothing rather than a
partial record.

⚠️ **Only the exact string `desktop` is PC.** Anything else — `console`, or a
value a future DayZ build introduces — is not a ban. An unrecognised device
must read as "not PC", never as "PC".

### 3.2 `player_devices` — new table

    dayz_id, device, gamertag, first_seen_at, last_seen_at
    primary key (dayz_id, device)

Keyed on the **pair**, not on the player. An account seen on both platforms
gets two rows, and the rule asks "has this account ever been seen on desktop?"
rather than "what was it last time?". Someone who alternates console and PC is
still a PC player, and a last-write-wins column would let them clear the flag
by playing one console session.

`gamertag` is kept for the ban row and for a human reading an ops message; the
`dayz_id` is the identity.

⚠️ **Outside the lock order** (spec §4.12), like `server_restarts`,
`vehicle_wipe_announcements` and `release_announcements`: written by one
component, in a single statement, referencing nothing.

### 3.3 `bans.reason` — new column

`text`, values `'zone'` and `'unlinked_pc'`, existing rows defaulted to
`'zone'`.

⚠️ Without this the lift path cannot tell a PC-gate ban from a
zone-enforcement ban, and opening a link challenge would lift a ban somebody
earned by griefing inside another clan's base.

### 3.4 The predicate — `packages/domain`

An account is ban-worthy when **all three** hold:

1. it has a `player_devices` row with `device = 'desktop'`; **and**
2. it has no `identity_links` row; **and**
3. it has no open `verification_challenges` row — `target_dayz_id` matches,
   `completed_at` null, `canceled_at` null, `expires_at` in the future.

Pure, table-driven, no database access. The tick supplies the three facts.

### 3.5 The tick — `apps/bot`

Gated on `UNLINKED_PC_BAN`. Writes one `bans` row per newly ban-worthy
account: `reason = 'unlinked_pc'`, `expires_at` **null**, `status = 'pending'`,
`incident_id` null. The existing ban tick applies it to Nitrado.

The ban is permanent because it is not a sentence to serve. It is a door that
opens when the player links.

### 3.6 The lift — inside `startLink`

Opening a challenge marks any `applied` ban for that `dayz_id` with
`reason = 'unlinked_pc'` as `lift_pending`, **in `startLink`'s own
transaction**.

⚠️ Same transaction, deliberately. A lift written separately could be lost
between the two writes, leaving a player who did exactly what we asked locked
out with nothing anywhere saying why.

The ban tick's lift arm then removes the Nitrado entry, reference-counting
against any other active ban for that account — which it already does
correctly, and which is why a PC ban can never free an account that also has a
zone ban.

### 3.7 Re-applying needs no code

If the challenge expires without completing, the account is once again
desktop + unlinked + no open challenge, so the next tick writes a fresh ban
row. The rule is **level-triggered**, like the truck wipe and the raid window:
every pass recomputes what should be true rather than reacting to an edge.

---

## 4. Lift once, ever

⚠️ **A second challenge lifts nothing.**

Without this, "starting a link lifts the ban" is an infinite supply of play
time: start a link, get unbanned, never complete it, play for 24 hours until
the challenge expires, start another. The player never links and never stays
banned.

One lift per account, for all time. A player who burns their window needs a
human — and that conversation is the right outcome for someone who has already
demonstrated they will not link.

---

## 5. Timing

    connect → worker sees player.connected      ≤ 60 s   (INGEST_INTERVAL_SECONDS)
            → RPT fetched, player_devices row    ~1 s
            → bot tick writes the ban row       ≤ 10 s   (BOT_TICK_INTERVAL_MS)
            → ban tick applies it to Nitrado    same tick

"On sight" is about a minute in practice.

---

## 6. Rollout

**Forward-only is structural, not a flag.** `player_devices` starts empty and
fills only when an account connects. We deliberately **do not backfill** from
the retained RPTs.

⚠️ This is what makes forward-only true, and it cannot be undone by a later
change of setting: the four known unlinked PC accounts are not in the table, so
nothing can act on them until they connect again. Anyone tempted to "just
backfill it while we're here" would be silently converting this design into the
retroactive sweep that was explicitly not chosen.

**`UNLINKED_PC_BAN` is its own gate,** absent by default, independent of
`BAN_DRY_RUN`.

⚠️ **In production today `BAN_DRY_RUN=false` and `ENFORCEMENT_TICK=1`.** The
ban path is live; it has simply never had a row to act on (`bans` holds zero
rows). There is no dry-run net under this feature by default: **the first PC
ban is real the moment the gate is set.** Setting it is a deliberate act on a
chosen day, not a side effect of a deploy.

**Notifications** go to `OPS_CHANNEL_ID`. There is no DM: not being linked is
precisely why we have no Discord id for them.

---

## 7. Failure modes, all failing closed

| What happens | Result |
|---|---|
| RPT fetch fails, Nitrado down | no device row → no ban |
| `dpnid` never resolves to a uid | sighting dropped → no ban |
| device string is not exactly `desktop` | not a ban |
| account already linked | never evaluated |
| challenge open | never evaluated |

Every unknown is "not PC". The design never bans on an inference.

**One consequence worth naming:** a linked PC player who later unlinks becomes
ban-worthy. That follows from the rule and is intended — unlinking is opting
out of the thing that bought the exception — but it will surprise someone, and
it should be in the ops message when it happens.

---

## 8. Testing

- **Parser**, against trimmed real RPT fixtures: a normal desktop login, a
  console login, the empty-uid-at-the-device-line case, and a login straddling
  a restart whose `dpnid` never resolves.
- **Predicate**, table-driven: linked, mid-challenge, expired challenge,
  canceled challenge, console, unknown device string, never-seen.
- **Lift**: `startLink` marks `lift_pending` only for `reason = 'unlinked_pc'`,
  and only once ever.
- **Mutation check on lift-once.** "Once" is exactly the kind of rule a test
  can assert while never exercising it; defeat the counter and the test must
  fail.
- **Re-apply**: an expired challenge produces a new ban row on the next tick.

---

## 9. Out of scope

- Any use of RPT data beyond the device type.
- Backfilling `player_devices` from retained RPTs (§6).
- Detecting PC players who have not connected since RPT retention began.
- Any change to zone-enforcement bans beyond adding `reason`.
