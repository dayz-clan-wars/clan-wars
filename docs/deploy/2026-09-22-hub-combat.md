# No combat at the Hub — deploy

A hit, a kill, or a trap placed at the Fast Travel Hub is an automatic one-hour ban,
and every kill made there — past and future — counts for nothing. Spec:
`docs/superpowers/specs/2026-09-22-hub-combat-design.md`. Zone and offence rule:
`packages/domain/src/hub.ts`. Ban tick: `apps/bot/src/hub-tick.ts`.

## 1. What ships

- **Migration 0047** (`0047_cute_fantastic_four.sql`) adds `kills.at_hub boolean not
  null default false`. Additive: the old bot neither selects nor writes it, so it is
  safe to apply with the bot running. The release deploy applies it
  (`deploy/deploy-release.sh`), and rebuilds the ingest-worker image — from then on,
  every new `player.hit` and `player.killed` event carries `victimPos`/`attackerPos`
  (`killerPos` on a kill).
- **The ban tick ships OFF.** `HUB_BAN_TICK` absent means `hubTick` never runs. Config
  refuses to load with it on and `ENFORCEMENT_TICK` off — `hubTick` only writes `bans`
  rows; `banTick` is what applies them.
- **Discrediting is live the moment the new bot runs** — every scoring read excludes
  `at_hub`. But until steps 4–5 below run, `at_hub` is false on every existing kill,
  so nothing in the past is discredited yet.

## 2. Before you start

- ⚠️ **There is no dry-run net.** Production runs `BAN_DRY_RUN=false` and
  `ENFORCEMENT_TICK=1`. The first Hub ban after step 7 is REAL.
- Pick a quiet hour. The bot is stopped from step 3 to step 7.
- Confirm the new ingest-worker image is running (a fresh `player.hit` carries
  `victimPos`):
  ```sql
  select id, payload ? 'victimPos' as has_pos from events
  where type = 'player.hit' order by id desc limit 3;
  ```
  ⚠️ If the newest hits do NOT have positions, the old worker is still running. Stop
  here — a backfill run now would leave every event the old worker writes afterwards
  without positions.
- The server id: `select id, name from servers where active;` (1 on this install).

## 3. Stop the bot

```bash
sudo systemctl stop clan-wars-bot
systemctl status clan-wars-bot     # inactive (dead)
```

## 4. Backfill positions onto past events

Dry run first — it counts and writes nothing:

```bash
cd /opt/clan-wars && set -a && . ./.env && set +a
pnpm --filter @factions/bot exec tsx ../../scripts/backfill-hub-positions.ts --server 1
```

Expect `unparsed` at or near zero. The raw line is matched by file and line number, so
events a reparse created (whose `raw_line_id` is null — 472 hits and 22 kills on
2026-09-22) are found too. A large `unparsed` means raw lines genuinely missing —
investigate before applying. Then:

```bash
pnpm --filter @factions/bot exec tsx ../../scripts/backfill-hub-positions.ts --server 1 --apply
```

Re-running is safe: an event that already has `victimPos` is skipped.

## 5. Rebuild kills

```bash
pnpm --filter @factions/bot exec tsx ../../scripts/rebuild-kills.ts --server 1
```

Verify:

```sql
select count(*) filter (where at_hub) as hub, count(*) from kills;
```

`hub` was ≈ 62 on 2026-09-22 (more if there has been fighting since).

The Discord feeds do **not** repost history after this. Every poster (#kill-feed,
#long-range, #killstreaks, #hit-feed) keeps its cursor on `kills.event_id` /
`events.id`, and the rebuild preserves event ids — only `kills.id` changes.

## 6. Revoke achievements

⚠️ After step 5, never before — until the rebuild, `at_hub` is false everywhere and
this finds nothing. Dry run first:

```bash
pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts
```

**Read the list.** Each `would revoke` line is a badge only Hub kills earned; each
`would re-date` line is a badge that still holds, moved to the real kill that earns it
(the rebuild renumbered `kills.id`, so its old evidence id is stale anyway). It re-runs
the twelve kill-derived PvP rules only (`REVOCABLE_KEYS`) — never a position, pin,
raid or defence rule. Nobody is notified. Then:

```bash
pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts --apply
```

A non-zero exit means a rule threw; that badge was left alone, not revoked.

## 7. Turn the ban on

Add to `.env` (not the command line — a flag passed only on the command line is gone
at the next restart):

```
HUB_BAN_TICK=true
```

```bash
sudo systemctl start clan-wars-bot
journalctl -u clan-wars-bot -f
```

Expect `HUB_BAN_TICK on: a hit, kill or trap at the Hub is a one-hour ban.` at
startup, then `hub watch: cursor seeded at the log head` on the first tick. ⚠️ Nothing
before that seed is ever banned — the cursor starts at the head, so the week of Hub
fighting before the rule is never replayed into bans. `HUB_OFFENCE_MAX_AGE_MS` (24 h)
is only the backstop if the `hub-watch` cursor row is ever lost.

Expect a burst of achievement work on this first start. `rebuild:kills` gave every kill
a new `kills.id`, above the achievement tick's watermark, so the tick treats every
player with a kill as touched and re-runs their rules once. That can **grant** badges,
with a Discord card each, and that is correct: a run that a Hub *death* used to break
now continues, so `killing_spree`/`unstoppable` can be newly earned with a past
`earnedAt`. Nothing already held is posted again.

## 8. Verify

```sql
select id, gamertag, status, banned_at, expires_at, applied_at
from bans where reason = 'hub_combat' order by id desc limit 10;
```

A Hub ban is written with `banned_at` = when the bot processed it (never the event's
time), goes `pending` → `applied` within one `banTick` block (5 min), and `expired` an
hour after `banned_at`. `#bans` announces it as "combat at the Fast Travel Hub".

## 9. Known limits

- The hour runs from when the ban is **written**; the few minutes before `banTick`
  applies it come out of the hour.
- Whether adding a player to Nitrado's ban list kicks them while already connected is
  not established. They are kept out when they next connect — and fast travel is a
  relog, so a Hub offender usually reconnects within minutes.
- `Plastic_Explosive` is in `HUB_TRAP_CLASSES` unobserved — it has never been placed on
  this server. Confirm the classname the first time it appears in an `item.placed`.
- A PvE survival achievement still counts a Hub death, exactly as it counts a
  friendly-fire death. Only the PvP achievements discredit a Hub kill.
- Discord posts already made about Hub kills (#kill-feed, #killstreaks, achievement
  cards) stay. They are records.

## 10. Rollback

Remove `HUB_BAN_TICK` from `.env` and `sudo systemctl restart clan-wars-bot`. Pending
Hub bans still apply and expire on their own within the hour.

⚠️ **Before turning it back on**, delete its cursor so it re-seeds at the head:

```sql
delete from consumer_cursors where consumer_name = 'hub-watch';
```

Left in place, the cursor still points at the moment the tick was switched off, and
the first tick back would ban every Hub offence from the last 24 h
(`HUB_OFFENCE_MAX_AGE_MS`) — offences committed while enforcement was off — in one pass. Leave `kills.at_hub` in
place — the column is harmless, and dropping it would need the old code back.
