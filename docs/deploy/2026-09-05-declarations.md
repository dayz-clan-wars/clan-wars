# Declarations — deploy runbook

Migration 0020 drops `factions.pole_key/x/y/z` and creates `declarations`. The running bot
selects those columns on every tick, so:

0. Read `packages/db/migrations/0020_declarations.sql` in full before anything else;
   nothing applies migrations in production.
1. `sudo systemctl stop clan-wars-bot`; confirm with `systemctl status clan-wars-bot`.
2. Precheck, read-only:
       select id, tag, status, ceremony_id from factions where status in ('reserved','active','dormant') and ceremony_id is null;
   Any row here has no ceremony to cite and the migration will refuse. On this deployment
   there are none (factions_live holds zero factions). If one ever appears, point it at the
   ceremony that founded it and let the migration do the move:
       update factions f set ceremony_id = c.id from ceremonies c
        where f.id = <id> and c.server_id = f.server_id and c.pole_key = f.pole_key and c.status = 'claimed';
   Re-run the precheck; it must return zero rows before step 3.
3. Apply 0020 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. Read the
   SQL first.
4. Launch grace — every pole the log has ever seen gets 7 days from today:
       update poles set grace_until = now() + interval '7 days';
   ⚠️ `poles` may be EMPTY on this host: the projector never ran here. That is fine — the
   bot's new pole projection fills it from `events` on its first tick, stamping
   first-sighting + 7 days, which for a pole first seen weeks ago is already in the past.
   So run step 5, wait one tick, then run the update above. Order matters.
5. Start the bot: `sudo systemctl start clan-wars-bot`. Watch `journalctl -u clan-wars-bot -f`
   for `pole projection: N poles`.
6. Re-run step 4's update, then the acceptance query:
       select count(*) filter (where grace_until > now()) as in_grace, count(*) as total from poles;
   `in_grace` must equal `total`.
7. Dormancy acceptance, rewritten for the join (replaces the query in CLAUDE.md):
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
