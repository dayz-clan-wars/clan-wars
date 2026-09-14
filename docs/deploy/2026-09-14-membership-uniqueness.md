# Deploy: migration 0035, one membership per server per Discord account

2026-09-14. Closes inbox item 17. **The first migration applied with
`pnpm db:migrate`** (`docs/deploy/2026-09-14-db-migrate.md`), rather than a
hand-assembled runner.

## What it is

    CREATE UNIQUE INDEX IF NOT EXISTS "faction_members_server_discord_uniq"
      ON "faction_members" USING btree ("server_id","discord_id");

One statement. The mirror of the `faction_members_server_player_uniq` that has
always existed on `(server_id, dayz_id)`: the same rule — one person, one
membership per server — keyed on the other of the two ids a player has.

## This is defence in depth, not a fix for a live bug

Four write paths already refuse to create a second row for one Discord account
(`unlinkDb`'s in-clan guard, `acceptInvite` and `decideRequestDb`'s
`INSERT ... SELECT` from `identity_links`, and the founding insert). What was
missing is anything enforcing it, while `leaderIs()` and `kick()` read
`(faction_id, discord_id)` through scalar subqueries — where a duplicate does
not degrade, it raises Postgres `21000` at whichever player runs the next
command. See PLAN-3-INBOX item 17 for the full evidence.

## Pre-check: production had no duplicates

Run before applying, and it returned zero rows:

```sql
select faction_id, discord_id, count(*) from faction_members
group by 1, 2 having count(*) > 1;
```

⚠️ **If that ever returns rows, the migration fails and nothing is written** —
`CREATE UNIQUE INDEX` is atomic. Resolve the duplicates first; do not drop the
index to force it through.

## Order

No NOT NULL column, no dropped column, and the table is tiny (8 rows at the
time of writing), so `CREATE UNIQUE INDEX`'s brief write lock is not worth
stopping the bot for. Old code runs correctly against the new schema: the index
only forbids rows that code already refuses to write.

```bash
cd /opt/clan-wars && git pull --ff-only
/home/acab/.local/bin/pnpm install

# Dry run first. It prints the tags it would apply and writes nothing.
DATABASE_URL="..." /home/acab/.local/bin/pnpm db:migrate

DATABASE_URL="..." /home/acab/.local/bin/pnpm db:migrate --apply --production
```

Expect `pending: 1` / `0035_noisy_nico_minoru`, then
`Applied 1. Now at 36 of 36.`

Nothing to restart for the migration itself. The bot picks up the new
`isDuplicateMembership` behaviour on its next ordinary restart.

## Rollback

    DROP INDEX faction_members_server_discord_uniq;

⚠️ Dropping it also needs the journal row removed from
`drizzle.__drizzle_migrations`, or `pnpm db:migrate` refuses on its next run
with `timestamp-mismatch` — which is the check working. Prefer rolling the code
back and leaving the index in place: it forbids only rows nothing writes.
