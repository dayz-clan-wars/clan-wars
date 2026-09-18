# Banning unlinked PC players — deploy

This server is for Xbox. A PC player is welcome if we know who they are; the ban is
what makes linking non-optional for the ones we don't. Design and rule:
`packages/domain/src/pc-gate.ts` (`pcGateAction`, `PcGateFacts`). Tick:
`apps/bot/src/pc-ban-tick.ts`. Device discovery: `apps/ingest-worker/src/device-tick.ts`,
reading `.RPT` files via `parseDevices` (`packages/adm-parser/src/device.ts`) into
`player_devices`.

## 1. What ships off

`UNLINKED_PC_BAN` is absent by default, and absence means the tick never runs — no
ban is ever written by this feature until an operator sets it. The ingest worker's
`deviceTick` runs regardless, unconditionally, and keeps learning which accounts play
on desktop into `player_devices`. That is deliberate: by the time you flip the gate,
the table is already warm with real data, and the first tick after enabling is not a
surprise discovery of however many PC players have connected since launch — it is a
read of a table that has been filling the whole time.

Config load enforces the dependency the other direction too: `UNLINKED_PC_BAN=1`
with `ENFORCEMENT_TICK` off throws at startup (`apps/bot/src/config.ts`) —
"`UNLINKED_PC_BAN is on but ENFORCEMENT_TICK is off — ban rows would be written and
never applied`". `pcBanTick` only ever writes `bans` rows; only `banTick`
(gated on `ENFORCEMENT_TICK`) reaches Nitrado to apply or lift one. Without
`ENFORCEMENT_TICK` you'd get a table full of `pending` rows and no bans ever actually
enforced — the throw exists so that state is never reached silently.

## 2. ⚠️ There is no dry-run net

Production already runs `BAN_DRY_RUN=false` and `ENFORCEMENT_TICK=1`. Unlike a fresh
feature you might exercise behind `BAN_DRY_RUN=true` first, setting `UNLINKED_PC_BAN=1`
here goes straight to a real Nitrado ban on the very next `banTick` after `pcBanTick`
writes the row — usually within the same 5-minute slot. There is no separate dry-run
flag for this feature; `BAN_DRY_RUN` is shared with zone enforcement and is already off.
**The first PC ban this feature produces is real the moment the gate is set.**

## 3. See who would be banned, before enabling

Run this against `factions_live` (read-only):

```sql
select d.gamertag, d.dayz_id, d.first_seen_at,
       (l.dayz_id is not null) as linked
from player_devices d
left join identity_links l on l.dayz_id = d.dayz_id
where d.device = 'desktop'
order by linked, d.first_seen_at;
```

Every row with `linked = f` is a ban the instant you enable the gate. Read the list
before you commit to it — the same discipline as `release:sync --dry-run`.

## 4. Enabling

Add to `/opt/clan-wars/.env`:

    UNLINKED_PC_BAN=1

then

    sudo systemctl restart clan-wars-bot

Watch `OPS_CHANNEL_ID` (or, if unset, the bot's error log — the same null-poster
fallback the raid-window tick uses) for `🚫 PC ban queued: …` lines, one per account
`pcBanTick` bans. If `OPS_CHANNEL_ID` is unset, a ban still happens; it is just only
visible in the log, so set it before you enable this if you want anything watching in
Discord.

## 5. Lifting a ban by hand (someone caught wrongly)

What to run depends on whether `banTick` has applied the row yet — check first:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select id, status, dayz_id, gamertag from bans where reason = 'unlinked_pc' and dayz_id = '<dayz id>' order by id desc;"

**Still `pending`** (not yet on Nitrado's list — `banTick` hasn't run since `pcBanTick`
wrote it): cancel it outright, without ever going through `lift_pending`:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "update bans set status = 'failed', last_error = 'cancelled by hand: false positive' where id = <id>;"

⚠️ This is the one hand-lift that **spends nothing**. The one-lift-per-account rule
(`liftSpent` in `PcGateFacts`) is derived from ban history, not a counter — "any row
that ever reached `lift_pending` or `lifted` spent this account's one chance"
(`pc-ban-tick.ts`) — and `failed` is neither, so this account's automatic lift is
still there if it's ever legitimately needed.

**Already `applied`** — it has a real entry on Nitrado's ban list, and only
`banTick`'s lift arm can remove it (the schema comment on `bans` is explicit:
"`lift_pending` is the only route to `lifted`… nothing else may write `status:
'lifted'` directly"):

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "update bans set status = 'lift_pending' where id = <id>;"

⚠️ **This route does NOT spend nothing** — reaching `lift_pending` is exactly what
the automatic lift also does, and `liftSpent` cannot tell the two apart: it is
derived purely from status, not from *why* the row got there. Hand-lifting an
already-applied ban this way permanently uses up that account's one automatic lift,
the same as if they'd started a link themselves. If this same account is later
legitimately caught unlinked on PC again, starting a link will **not** open the door
a second time — it will need another hand-lift, deliberately, because the one
automatic chance is already spent.

⚠️ The lift only ever applies to an `applied` ban — one Nitrado has actually enforced.
A `pending` row that `pcBanTick` marks for an active link challenge is lifted
automatically on a later pass, once `banTick` has applied it first; nothing is lost
in the meantime, because no lift is spent until the row actually reaches
`lift_pending`.

### Someone burned a player's lift — a third party started the link

⚠️ **Known and unfixed.** A link challenge is matched on `target_dayz_id`
alone, and any Discord user may open one against any known unlinked gamertag —
gamertags are public. So a third party can start a link *against* a banned
player, which spends that player's ONE automatic lift, let it lapse without
completing it, and leave them with no automatic route back in.

**Symptom:** a player insists they never started a link, but their ban shows a
row that reached `lift_pending` or `lifted`:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select id, status, banned_at from bans where reason = 'unlinked_pc' and dayz_id = '<dayz id>' order by id desc;"

**Remedy:** hand-lift them (§5 above) — and note that the automatic lift is
**already spent**, so it will not open again on its own. Every later occasion
for this account needs another hand-lift. Believe the player: there is nothing
in the data that distinguishes a lift they asked for from one someone else
triggered on their behalf.

The proper fix means deciding who owns a link attempt, which is a change to the
linking model and needs its own design; it is deliberately not in this ship.

## 6. ⚠️ Never backfill `player_devices`

Do not, under any circumstance — not in a migration, not in a one-off script, not "just
to test" against a copy of `factions_live` — load `player_devices` from the retained
`.RPT` history. The table's emptiness *is* the mechanism that makes this feature
forward-only: `deviceTick` only ever learns a device when a **recently-connected**
account (`DEVICE_LOOKUP_LOOKBACK_MS`, 30 minutes) has no row yet, and `pcBanTick` only
ever considers accounts that already have a `player_devices` row. A backfill from
retained logs would hand `pcBanTick` every PC account that has EVER connected, going
back to whenever those logs start — turning a feature designed to act only on people
playing right now into a retroactive sweep that bans everyone who ever played this
server from PC, all at once, the next time the gate is on. There is no dry-run net
(§2) to catch that before it reaches Nitrado.

## 7. Turning it off

Unset `UNLINKED_PC_BAN` and restart:

    sudo systemctl restart clan-wars-bot

⚠️ **This does not lift any ban already applied.** The gate only stops `pcBanTick`
from writing new `bans` rows; it does nothing to rows already `pending`, `applied`, or
`lift_pending`. `banTick` (governed by `ENFORCEMENT_TICK`, not this gate) keeps
reconciling whatever is already there. If you mean to lift every standing
`unlinked_pc` ban as part of turning this off, do it deliberately:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "update bans set status = 'lift_pending' where reason = 'unlinked_pc' and status = 'applied';"

(Only `applied` rows have anything on Nitrado's list to remove — see §5's note on
`pending` rows.)
