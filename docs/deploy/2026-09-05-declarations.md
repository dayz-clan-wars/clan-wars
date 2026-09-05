# Declarations — deploy runbook

Migration 0020 drops `factions.pole_key/x/y/z` and creates `declarations`. The running bot
selects those columns on every tick, and the drops are **irreversible** — there is no down
migration and the coordinates exist nowhere else once they are gone. So, in order:

1. **Read the migration.** `packages/db/migrations/0020_declarations.sql` in full, before
   anything else. Nothing applies migrations in production.
2. **Stop the bot.** `sudo systemctl stop clan-wars-bot`; confirm with
   `systemctl status clan-wars-bot`.
3. **Precheck, read-only:**

       select id, tag, status, ceremony_id from factions
        where status in ('reserved','active','dormant') and ceremony_id is null;

   Any row here has no ceremony to cite and the migration will refuse. On this deployment
   there are none (`factions_live` holds zero factions). If one ever appears, point it at
   the ceremony that founded it and let the migration do the move:

       update factions f set ceremony_id = c.id from ceremonies c
        where f.id = <id> and c.server_id = f.server_id and c.pole_key = f.pole_key and c.status = 'claimed';

   Re-run the precheck; it must return zero rows before step 5.
4. **Back up, before a single statement of 0020 runs.** Schema and data for the two tables
   the migration reads and writes:

       docker exec clan-wars-postgres-1 pg_dump -U factions -d factions_live \
         -t factions -t poles --format=plain \
         > ~/declarations-0020-backup-$(date +%Y%m%d-%H%M).sql

   A dump of the whole database is fine too, and simpler if you would rather not reason
   about which tables matter. ⚠️ This is the ONLY recovery path. 0020 drops
   `factions.pole_key/x/y/z`; a run that dies halfway — after the drops, before the
   `declarations` backfill lands, or with the backfill wrong — cannot be rolled forward or
   reversed, because the coordinates it needed are already gone. Recovery is restore from
   this dump. Check the file is non-empty and mentions `COPY public.factions` before
   continuing.
5. **Apply 0020** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
6. **Start the bot.** `sudo systemctl start clan-wars-bot`.
7. **Wait one tick, watching the journal.** `journalctl -u clan-wars-bot -f`, looking for
   `pole projection: N poles`.

   ⚠️ `poles` may be EMPTY before this tick: the projector never ran on this host. That is
   fine — the bot's new pole projection fills it from `events` on its first tick, stamping
   first-sighting + 7 days, which for a pole first seen weeks ago is already in the past.
   That is exactly why the grace stamp in step 8 comes AFTER this tick and not before:
   stamping an empty table stamps nothing, and the tick would then fill it with graces that
   have already expired. Order matters.

   ⚠️ `pole projection: N poles` is logged **only when N > 0**. On a host with zero flag
   events in the log there is nothing to project and the line never appears, which reads
   identically to a projection that failed. Do not wait for it indefinitely — after a tick
   interval, check the table directly instead:

       select count(*) from poles;

   (A pole projection that genuinely fails now logs `pole projection failed` on its own
   line; it no longer hides behind the player projection's error.)
8. **Stamp the launch grace** — every pole the log has ever seen gets 7 days from today:

       update poles set grace_until = now() + interval '7 days';

9. **Acceptance.** First the grace:

       select count(*) filter (where grace_until > now()) as in_grace, count(*) as total from poles;

   `in_grace` must equal `total`.

   Then dormancy, rewritten for the join (this replaces the query in `CLAUDE.md`):

       select f.tag, f.status, f.dormant_since,
              now() - coalesce((select max(e.occurred_at) from events e
                where e.type='flag.raised' and e.server_id=f.server_id
                  and e.payload->>'poleKey'=d.pole_key
                  and e.payload->>'texture'=f.texture
                  and e.payload->>'dayzId' in (select dayz_id from faction_members where faction_id=f.id)),
                f.activated_at, f.created_at) as age
       from factions f left join declarations d on d.owner_faction_id = f.id
       where f.status in ('active','dormant');

   Read it together with `select count(*) from factions` — zero rows means two things.
   Note: the solo lapse clock is separate from this query — for a solo declaration it
   starts at `declared_at`, or the declarant's last raise, whichever is later.
