# Scheduled restarts from the bot — design

**Date:** 2026-09-12
**Status:** approved in conversation, awaiting written review

## 1. What this is

The bot restarts the game server at the top of every even UTC hour (00:00, 02:00 … 22:00 —
twelve a day) through Nitrado's API, instead of relying on the `messages.xml` shutdown
entry, whose schedule is relative to the server's last boot and so drifts with every
restart and every crash. The bot side is the whole scope: `messages.xml` is not touched,
read, or rewritten by anything here.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Who restarts | The bot, in its existing 10 s tick loop — not a systemd timer, not the worker |
| When | Even UTC hours, on the hour. Two-hour slots aligned to the Unix epoch, which is itself an even hour |
| In-game warnings | Unchanged. `messages.xml` keeps whatever it does today; the bot neither edits nor depends on it |
| Discord | Silent. The bot's journal is the only record besides the table below |
| Proof and idempotency | A `server_restarts` table: one row per server per slot |
| Off by default | `RESTART_SCHEDULE=1` turns it on; `NITRADO_TOKEN` (already in `.env` for the worker) is required once it is on |

⚠️ If `messages.xml` still carries a shutdown entry, both schedules fire. The bot's
status check (§4) stops a double restart only when the two land inside one boot; trimming
the shutdown out of `messages.xml` is a hand step for the operator, deliberately outside
this design.

## 3. The schedule

Constants in `packages/domain/src/rules.ts`:

- `RESTART_PERIOD_MS = 2 h` — the slot length.
- `RESTART_GRACE_MS = 10 min` — how long after a slot opens the bot may still fire it.

A slot is `slotStart = floor(now / RESTART_PERIOD_MS) * RESTART_PERIOD_MS`. Because the
epoch is 1970-01-01 00:00 UTC, every slot starts on an even UTC hour with no phase
constant to get wrong. The slot is *due* while `slotStart <= now < slotStart + RESTART_GRACE_MS`
and no `server_restarts` row exists for `(server_id, slotStart)`.

- Bot down 13:55 → 14:03: fires at 14:03 (inside grace).
- Bot down 13:55 → 14:20: the 14:00 slot is *missed*; one error-level log line, a row
  with `outcome = 'missed'`, no restart. A restart twenty minutes late kicks players who
  had no countdown, and the next slot is at most 100 minutes away.
- Bot restarted at 14:00:05 after firing at 14:00:01: the row exists, nothing fires.

Not a guide number: the guide does not state restart times today, and nothing on the
site reads this. If it ever should, the constant is already where `guide-numbers.ts`
expects it.

## 4. The tick

`apps/bot/src/restart-tick.ts`, `restartTick(db, nitradoFor, { now })`, run each pass
right after `reaperTick` (housekeeping, not a consumer — it reads no cursor), gated on
`cfg.restartSchedule`. For each row of `servers` with `active = true` and a
`nitrado_service_id`, when the current slot is due:

1. `GET /services/{id}/gameservers` — read `status`. Only `started` is restarted. Any
   other status (`restarting`, `stopping`, `stopped`, unknown) writes a row with
   `outcome = 'skipped'` and the status in `detail`, and logs at warn. This is what keeps
   a `messages.xml` shutdown or a manual restart from being followed by a second one.
2. `POST /services/{id}/gameservers/restart` with `{ message: "Scheduled restart",
   restart_message: "Scheduled restart" }` — the same client the worker uses,
   `NitradoClient.restart()`, new, routed through the existing `postJson` so the
   `status:"error"`-with-HTTP-200 guard applies.
3. On success: a row with `outcome = 'restarted'`, `issued_at = now`.
4. On a throw (network, Nitrado error, timeout): **no row** — the next tick retries, every
   10 s, until the grace window closes, at which point the slot is recorded `missed` with
   the last error in `detail`. Errors are logged at error level on every attempt.

One server at a time, sequentially, each in its own try/catch: one service's failure
never blocks another's (there is one server today; the loop costs nothing).

`nitradoFor(serviceId)` is a memoised `NitradoClient` per service id, the shape the
worker's `clientFor` already has, constructed with `cfg.nitradoToken`.

## 5. Storage

Migration 0032, additive:

```sql
create table server_restarts (
  server_id      integer     not null references servers(id),
  scheduled_for  timestamptz not null,   -- the slot start
  issued_at      timestamptz not null,   -- when the row was written
  outcome        text        not null,   -- 'restarted' | 'skipped' | 'missed'
  detail         jsonb       not null default '{}',
  primary key (server_id, scheduled_for)
);
```

The primary key is the idempotency guard: a row for `(server_id, slotStart)` means the
slot is handled, whatever the outcome, and the tick never restarts a server whose slot
has a row.

⚠️ Order: the POST first, the row second. A row written before the POST would record a
restart that never happened if the POST then failed. The reverse risk — the process dying
between the POST and the insert — is what the status check absorbs: on the retry the
server reports `restarting`, so the slot is recorded `skipped`, not restarted twice.

`missed` is written by the first pass that finds the newest slot past its grace window
with no row: the bot was not running (or was failing) for the whole window. `detail`
carries the last error text if there was one, else `{ "reason": "not running" }`.

Lock order: `server_restarts` is written by this tick alone, in its own transaction,
touching no other table — it needs no position in §4.12's list, and this is noted there.

## 6. Configuration

`apps/bot/src/config.ts`:

- `restartSchedule: boolean` from `RESTART_SCHEDULE` (`1`/`true`), default off.
- `nitradoToken: string | undefined` from `NITRADO_TOKEN`; config load **fails** when
  `restartSchedule` is on and the token is missing (a schedule that is on but cannot
  authenticate must not look like one that is working).

`apps/bot/README.md` env table gains both rows. `.env.example` gains `RESTART_SCHEDULE`.

## 7. Errors and visibility

- Every fired restart: one info line `restart: server <id> restarted for <slot ISO>`.
- Skipped: warn, with the status. Missed: error, with the last error text.
- `systemctl status` says nothing about this (CLAUDE.md's warning stands): the check is
  `select * from server_restarts order by scheduled_for desc limit 12;` — twelve rows a
  day, all `restarted`, is the schedule working.

## 8. Tests

- `packages/nitrado/test/client.test.ts`: `restart()` posts to the right path with the
  message, throws on `status:"error"` under HTTP 200; `status()` reads the gameserver status.
- `apps/bot/test/restart-tick.test.ts` (test database, fake clock, fake Nitrado):
  - fires once in a slot and writes `restarted`; a second pass in the same slot does nothing;
  - fires inside the grace window after downtime; records `missed` outside it, with no call;
  - retries after a throw, then records `restarted` on the next pass's success;
  - `skipped` with no POST when the server reports `restarting`;
  - two active servers: one failing never blocks the other;
  - an inactive server, or one with no service id, is never touched.
- `apps/bot/test/config.test.ts`: on-without-token fails to load; off-without-token loads.
- `packages/domain/test`: the slot arithmetic — `slotFor(now)` lands on even UTC hours
  across a DST boundary (UTC has none, which is the point) and at the epoch.

## 9. Deploy

Runbook `docs/deploy/2026-09-12-scheduled-restarts.md`: apply 0032 with the one-off
runner; deploy the bot with `RESTART_SCHEDULE` unset; set `RESTART_SCHEDULE=1` in `.env`
and restart the bot at a quiet moment more than ten minutes past an even hour, so the
first slot it sees is a clean one; verify the next even hour produces a `restarted` row
and a fresh ADM file. Rollback: unset the flag, restart the bot.

## 10. Out of scope

Rewriting `messages.xml`; Discord warnings; a per-server or configurable phase; restarts
on demand (`/restart`); a status page. Each is a separate decision if it ever comes.
