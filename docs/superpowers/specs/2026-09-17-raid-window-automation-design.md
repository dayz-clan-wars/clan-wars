# Raid window automation — design

**Status:** approved 2026-09-17, not yet implemented
**Supersedes:** the manual half of `docs/deploy/raid-window.md`
**Reverses:** the 2026-09-01 supplies design's refusal to automate `cfggameplay.json`

Base damage is on from Friday 00:00 UTC to Monday 00:00 UTC. Today a human flips
`GeneralData.disableBaseDamage` in the game server's `cfggameplay.json` through the
Nitrado web panel and restarts the server, twice a week, every week. This design
automates that flip, states the window's real state on the website, and announces it
in Discord.

---

## 0. The decision being reversed, and why it is acceptable now

`docs/deploy/raid-window.md` says:

> the supplies design (2026-09-01) refused to automate this file because a bad write
> breaks the map for everyone, and that stands.

That refusal was written before `apps/bot/src/events-xml.ts` existed. The truck wipe
now performs the same shape of operation on `events.xml` — a surgical single-key edit of
a mission file, level-triggered, uploaded only when the content actually changes — and has
run in production since 2026-09-12 without incident.

⚠️ **The risk is not the same, and this design does not pretend it is.** A malformed
`events.xml` degrades: some events stop spawning. A malformed `cfggameplay.json` means
**the game server does not start at all, for every player**. §2.3 is what pays for that
difference; it is stricter than anything the truck wipe does, deliberately.

## 1. Domain — one answer, computed once

`packages/domain/src/raid-window.ts`:

```ts
export type RaidPhase = "open" | "closed" | "skipped";
export type SkippedWindow = { opensAt: Date; reason: string };
export type RaidWindowState = {
  phase: RaidPhase;
  /** What GeneralData.disableBaseDamage should be at `when`. */
  baseDamageDisabled: boolean;
  /** The window containing or following `when`. */
  opensAt: Date;
  closesAt: Date;
  /** Set only when phase is "skipped". */
  skipReason?: string;
};

export function raidWindowAt(when: Date, skips: SkippedWindow[]): RaidWindowState;
```

Derived from the existing `RAID_WINDOW = { openDow: 5, closeDow: 1 }` in `rules.ts`.
⚠️ Those two numbers are not re-stated anywhere in this feature — the guide's appendix
already renders them through `guide-numbers.ts` (`RAID_WINDOW: "Fri 00:00 → Mon 00:00
UTC"`), and a second copy in the tick or the site is the drift this repo writes tests
against.

All arithmetic in UTC. There is no local time anywhere in this feature and therefore no
DST case to get wrong.

`baseDamageDisabled` is the inverse of "raiding is live", and is stated as the **file's**
value rather than the player-facing one so that the tick never has to invert anything at
the point of writing. A tick that computes "raiding is open" and then negates it at the
write site is one `!` away from opening the window on Monday.

## 2. The flip

### 2.1 It rides the existing restart slots

`applyRaidWindow()` lives in `apps/bot/src/restart-tick.ts`, immediately beside
`applyTruckWipe()`, and is called from the same place in the same order.

`RESTART_PERIOD_MS` is 2 hours and slots are aligned to the Unix epoch, so Friday 00:00
and Monday 00:00 UTC are both restart slots. The scheduler already wakes exactly on both
boundaries. **This feature adds no timer, no cron and no new scheduling concept.**

⚠️ The setting is read at server start. The flip is written immediately *before* the
restart that slot was going to perform anyway — the same ordering `applyTruckWipe` relies
on. Writing without a restart changes nothing; restarting without writing changes nothing.

### 2.2 Level-triggered, never edge-triggered

Every slot recomputes the wanted value and converges the file to it — not just the two
boundary slots. The 10 other daily slots each verify and repair.

⚠️ This is the property that makes a bot outage survivable. A bot down across Friday
00:00 opens the window late rather than not at all, and a lost or hand-reverted write is
corrected within two hours. An edge-triggered design ("on the Friday slot, set false")
leaves the window shut for a whole weekend if the bot misses one tick, and nothing
anywhere would notice.

A file already in the wanted state is **never re-uploaded**. The download still happens —
that is the check.

### 2.3 The three guards

**Guard 1 — surgical edit, never reserialize.** The edit is a regex replacement of the one
boolean, in the shape `events-xml.ts` already establishes:

```
"disableBaseDamage"<ws>:<ws>(true|false)
```

⚠️ Never `JSON.parse` → mutate → `JSON.stringify`. The live file is tab-indented, 4,450
bytes, with a specific key order; reserializing rewrites every line, making the diff
unreviewable and silently reformatting a file a human may need to read under pressure.

The replacement must match **exactly once**. Zero matches (the key was renamed or removed)
and two or more matches (the key appears in another object) are both failures, not
best-effort cases.

**Guard 2 — validate the result before it is uploaded.** Both of these must hold:

1. `JSON.parse(result)` succeeds.
2. The parsed `GeneralData.disableBaseDamage` strictly equals the wanted boolean.

⚠️ Check 2 exists because check 1 is not sufficient: a regex that matched a
`disableBaseDamage` key in some other object produces a file that parses perfectly and
leaves `GeneralData` untouched. Parsing proves the file is loadable; only reading the
value back proves the edit did what it meant to.

A failure of either guard means **no upload**, an ops alert (§5), and the previous file
left exactly as it was. Refusing to write is always safe here; the window opening two
hours late is a disappointment, and a server that will not boot is an outage.

**Guard 3 — keep the pre-edit content.** The full previous file is stored on the flip row
(§3) before any upload. The truck wipe does not do this and does not need to. Here it is
the one-command recovery path for the failure mode that stops the server booting, and
4.5 KB per flip is nothing.

### 2.4 Where the file is

Mission root — verified against the live file server on 2026-09-17:

```
/games/ni11558038_4/ftproot/dayzxb_missions/dayzOffline.enoch/cfggameplay.json
```

`packages/nitrado/src/client.ts` has a private `missionDir()`; this feature promotes it to
a public `missionRootDir()` alongside `missionCustomDir()` and `missionDbDir()`.

⚠️ `missionDbDir()`'s comment currently reads as an exhaustive listing of the mission root
("the mission root holds only cfgeconomycore.xml, cfgeventspawns.xml, cfgeventgroups.xml
and the `db`/`env`/`custom` dirs"). It is not exhaustive — the root holds 25 files
including `cfggameplay.json`. That comment is corrected as part of this work, because the
next person to read it will conclude this file cannot be where it is.

### 2.5 Configuration

`RAID_WINDOW_TICK` gates the whole feature (empty/absent = off). ⚠️ Config load fails if it
is on while `RESTART_SCHEDULE` is off — the flip has no way to take effect without the
restart that applies it, and a tick that writes a file nobody reloads is the silent
no-op class this repo writes guards against (see `TRUCK_WIPE_EVENTS`, same rule).

## 3. Confirmed state, not intent

New table `raid_window_flips`, keyed **(server_id, boundary_at)** — the flip is per server.

| column | |
|---|---|
| `server_id`, `boundary_at` | the **window boundary** this flip realises |
| `wanted_disabled` | the boolean the file should carry |
| `outcome` | `applied` · `refused` · `failed` |
| `applied_at` | when the upload succeeded |
| `restart_confirmed_at` | set once the slot's restart is known to have run |
| `previous_content` | the pre-edit file (guard 3) |
| `detail` | error text for `refused`/`failed` |

⚠️ **`boundary_at` is the window boundary, not the slot.** It is the Friday 00:00 or
Monday 00:00 instant the file is being brought into line with — so a repair write at
Saturday 14:00 belongs to that Friday's row, not to a row of its own. The row is
**upserted**, one per (server, boundary): the first write that achieves the wanted state
creates it, and a later repair of a reverted file updates it.

⚠️ **A file already in the wanted state writes no row.** The level-triggered tick
checks 12 times a day; recording each check would put ~84 rows a week into a table whose
entire purpose is to answer "did the flip happen", and bury the four rows that matter.
Absence of a row for a past boundary is exactly the signal the website and the `open`/
`close` announcements read as "not confirmed".

⚠️ `restart_confirmed_at` is filled **after** the slot's restart result is known —
`restart-tick.ts` performs the write and the restart in that order within one slot, and
records the restart's outcome in `server_restarts` either way. A flip whose upload
succeeded but whose restart did not is not yet in effect, and must not read as confirmed.

⚠️ This table is what makes every other surface honest. The website and the Discord
open/close messages read **confirmed** flips, never the clock. A system that computes
"it is Friday, therefore raiding is live" tells players base damage is on at exactly the
moment a failed flip means it is not — and they find out by swinging at a wall. An alert
that is confidently wrong when it matters is worse than no alert.

## 4. Skips

New table `raid_window_skips`, keyed on `opens_at`, carrying `reason` and `decided_at`.

Read by all three consumers: the tick leaves `disableBaseDamage` true, the site says
"SKIPPED THIS WEEK" with the reason, and Thursday's Discord notice explains it rather than
promising a window that will not open.

Created by `pnpm raid:skip --opens <ISO> --reason "…"`, following the conventions of the
other one-off scripts (`factions_live` guard, `--allow-test-db` escape). No admin UI:
`docs/deploy/raid-window.md`'s exceptions table records exactly one use in the repo's
history, and a page for a twice-a-year action is not worth its own maintenance.

⚠️ A skip is a decision, never a catch-up. The runbook's existing rule stands and is
inherited by the automation: a skipped weekend is not compensated by opening a window on
a different day.

## 5. Discord

New `apps/bot/src/raid-window-tick.ts`, modelled directly on `announce-tick.ts`, including
its **post first, row second** rule — a row written first records an announcement that
never went out, and the reverse costs at most a duplicate after a crash between the two,
which is the direction this repo chooses everywhere.

New table `raid_window_announcements`, keyed **(boundary_at, kind)**.

⚠️ No `server_id` in that key. `vehicle_wipe_announcements` carries a ⚠️ for exactly this
reason: keyed per server, one message posts per server. These are single messages about a
single schedule.

| kind | when | says |
|---|---|---|
| `advance` | Thursday | the window opens tomorrow — or why it is skipped |
| `open` | Friday, **after** the flip is confirmed | base damage is on |
| `close` | Monday, **after** the flip is confirmed | base damage is off |
| `failure` | on `refused`/`failed` | what failed and what the file still says |

⚠️ The `(boundary_at, kind)` key means **one `failure` message per boundary**, not one
per slot. A persistent failure is re-attempted every two hours by the level-triggered tick;
without that key it would also be re-announced every two hours, and the alerts this design
relies on someone reading would be buried under 12 copies a day — the same reasoning as the
deploy system's notified-marker sidecars.

⚠️ `open` and `close` are gated on a confirmed flip, not on the clock. Announcing at the
boundary and flipping separately would produce a message that is a prediction; this makes
it evidence.

Player-facing kinds post to `ANNOUNCEMENTS_CHANNEL_ID`, as the vehicle notice does.
`failure` posts to a new `OPS_CHANNEL_ID`, gated the way `WAR_LOG_CHANNEL_ID` is — unset
means the failure is logged at error level and nothing else, which is the current
behaviour for everything else and not a regression.

## 6. The website strip

New read `raidWindow()` exported from `@factions/roster`, returning the state from §1
enriched with the confirmed flip from §3.

⚠️ Adding it means adding it to the export allowlist pinned **by name** in both
`packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`. That allowlist is
the boundary the whole "website is a surface, never a source of truth" invariant leans on.
This export is a read; it writes nothing, which is what makes it admissible at all.

Rendered beside `ServerStrip` in `apps/web/app/(site)/layout.tsx` and
`apps/web/app/guide/layout.tsx` — both already perform exactly this shape of cheap read
that never fails the page (`.catch(() => …)`, no strip rather than an error).

Server component for the state; a small client component for the countdown only.

| state | shown when |
|---|---|
| `RAID WEEKEND: LIVE — closes in 14h 22m` | window open, flip confirmed |
| `RAID WEEKEND: CLOSED — opens in 2d 6h` | window closed, flip confirmed |
| `RAID WEEKEND: OPENING — not yet confirmed` | boundary passed, no confirmed flip |
| `RAID WEEKEND: SKIPPED THIS WEEK — <reason>` | a skip covers this window |

⚠️ **Which flip counts as confirmation.** The strip resolves the window containing
`now` and looks for a confirmed flip at *that window's* boundary — `opensAt` while the
window is open, `closesAt` once it has closed. A confirmed flip from the previous weekend
never satisfies the current one. When the resolved boundary has no confirmed flip and the
boundary is in the past, the strip shows the unconfirmed state rather than the clock's
answer.

⚠️ `/` sits outside both layouts on purpose (`apps/web/test/menu.test.ts` pins that), so
the landing page carries no strip. That is accepted, not an oversight.

## 7. Documents that change with this

- **`docs/deploy/raid-window.md`** stops being a twice-weekly procedure and becomes a
  description of the automation, keeping the manual panel steps as the fallback for when
  `RAID_WINDOW_TICK` is off or a flip is refused.
  ⚠️ `packages/domain/test/raid-window-runbook.test.ts` holds that document against
  `rules.ts`, so it changes in lockstep or the gate fails.
- **One line in that runbook is wrong today** and is corrected here: "The window only
  decides whether walls, gates and containers take damage." `disableContainerDamage` is
  `false` on the live server and nothing has ever flipped it, so containers are damageable
  every day of the week.
  ⚠️ **No player-facing promise is broken.** The guide says only that "walls do not take
  damage" outside the window (`05-raiding.html`) and the word "container" appears nowhere
  in `apps/web/content/guide/` or `guide-numbers.ts`. The inaccuracy is internal.
  Windowing container damage as well was considered and **deliberately rejected** on
  2026-09-17: it is a real change to how players may spend their week, and it belongs to
  its own decision with its own announcement, not smuggled in with an automation change.
- **`CLAUDE.md`** gains the tick in the `discord.ts` tick-order paragraph and the new env
  vars.

## 8. Testing

- **Domain, pure:** both boundaries; the instants either side of them; a skipped window;
  overlapping and duplicate skips; a `when` far from any window.
- **The surgical edit:** the real 4,450-byte `cfggameplay.json` as a fixture. Assert the
  output differs from the input in exactly one value; assert `JSON.parse` round-trips;
  assert every other key is byte-identical. Then the refusal cases — key absent, key
  duplicated in another object, value already correct (no upload), file that does not
  parse on the way in.
- ⚠️ **A test that proves the guard, not just the happy path:** feed an input crafted so a
  naive regex matches the wrong occurrence, and assert the write is *refused* rather than
  performed. Guard 2 exists for that case alone, and a test suite that only exercises
  well-formed input would pass with guard 2 deleted.
- **Tick:** level-triggered convergence across a simulated week of slots, including a
  window of slots missed entirely (bot down) and a hand-reverted file.
- **Announcements:** each kind once and only once; `open`/`close` suppressed while no flip
  is confirmed; post-fails-then-row-not-written.
- **Site:** all four strip states.

## 9. What this design does not do

- **It does not window container damage.** §7.
- **It does not add a second scheduler.** If `RESTART_SCHEDULE` is off, this feature is off.
- **It does not touch any other key in `cfggameplay.json`**, and it does not reformat the
  file.
- **It does not back-fill.** A window that closed while the bot was down is over; the tick
  converges to what the current slot wants, never to what a past slot wanted.
- **It provides no UI for skips.** §4.
