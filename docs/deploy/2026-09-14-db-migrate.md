# Applying migrations: `pnpm db:migrate`

2026-09-14. Closes inbox item 28. Replaces the hand-assembled one-off runner in
`docs/deploy/2026-09-02-dormancy.md`, which stays as the incident record.

Every migration before this reached `factions_live` through a script typed at the
moment of a deploy, from a runbook. The two checks that made applying `0015` safe
rather than lucky — the `factions_live` guard and the
`__drizzle_migrations`-vs-journal comparison — are now in the script itself.

## Still true, and still the point

**Nothing applies migrations automatically.** Not the bot, not the site, not a
container entrypoint. `runMigrations` is called only from this script and from test
setup. A NOT NULL migration must be applied with the bot *down*
(`docs/deploy/2026-09-01-targeted-linking.md` is the incident that made that a rule),
and a service that migrates itself can never satisfy that.

## The steps

Generate and **read the SQL** before it goes anywhere near production:

```bash
cd packages/db && npx drizzle-kit generate
```

Then, on the production host, in `/opt/clan-wars`:

```bash
# 1. Dry run. Read-only, safe at any time, and it is the pre-check.
DATABASE_URL="$(grep ^DATABASE_URL .env | cut -d= -f2-)" /home/acab/.local/bin/pnpm db:migrate

# 2. Stop the bot if the migration adds NOT NULL columns or constraints.
sudo systemctl stop clan-wars-bot

# 3. Apply.
DATABASE_URL="..." /home/acab/.local/bin/pnpm db:migrate --apply --production

# 4. Start the new code.
sudo systemctl start clan-wars-bot
journalctl -u clan-wars-bot -n 50 --no-pager
```

⚠️ `pnpm` is not on the non-interactive ssh PATH. Use the full path.

## What the flags mean

- **No flags — dry run.** Prints the target, the journal, what is applied, and the
  exact tags it would apply. Writes nothing. Exit 0.
- **`--apply`** — applies them.
- **`--production`** — required to apply to `factions_live`, AND refused against any
  other database. The guard runs both ways on purpose: the flag cannot be carried by
  muscle memory onto a database it did not mean. (This differs from `pnpm wipe` and
  `pnpm launch`, whose `--allow-test-db` only refuses to *leave* production.)

Exit codes: `0` done or dry run, `1` refused or inconsistent, `2` usage error.

## What it refuses, and why

`planMigrations` (`packages/db/src/migration-plan.ts`) decides before anything is
written. The rule is one sentence: **with `count` rows applied, the newest of them
must be the journal's entry at `count - 1`.**

- **`timestamp-mismatch`** — the newest applied timestamp is not that entry's `when`.
  This is the hazard the dormancy runbook names: the migrator applies every journal
  entry whose `when` is newer than the newest `created_at`, comparing *timestamps*, so
  a `__drizzle_migrations` table filled in by hand with timestamps of its own will
  **replay old migrations** against live data. Reconcile the table by hand first.
- **`more-applied-than-journalled`** — the database is ahead of the code. Deploy the
  matching code; do not migrate.
- **`journal-not-ascending`** — two entries out of order or sharing a timestamp. The
  migrator would skip one for good, and never say so.

After applying, the script re-reads the table and checks the result against the plan.
The migrator reports neither what it applied nor that it applied anything, so that
re-read is the only evidence the deploy step produces.

## Verifying by hand

The dry run replaces this, but the underlying query is unchanged:

```sql
select count(*), max(created_at) from drizzle.__drizzle_migrations;
```

Compare `count` against the number of entries in
`packages/db/migrations/meta/_journal.json`, and `max(created_at)` against the `when`
of the entry at `count - 1`.
