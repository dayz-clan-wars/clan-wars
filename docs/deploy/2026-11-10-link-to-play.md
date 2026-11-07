# Link to play — deploy runbook (2026-11-10)

Every gamertag that plays must be linked to a Discord account. An unlinked gamertag gets
one hour of total play from the launch instant, then an `unlinked` ban. Losing a link
(leaving the Discord, unlinking) bans at once. Starting a link attempt lifts the ban for
one hour, at most once per 24 h per gamertag; linking ends it for good. Spec
`docs/superpowers/specs/2026-11-06-link-to-play-design.md`.

Commands on the host run from `/opt/clan-wars` with `.env` sourced. Database checks use
`sudo docker compose exec -T postgres psql -U factions -d factions_live -X` and are
read-only: wrap each in `begin read only; … rollback;`.

⚠️ `BAN_DRY_RUN` is false in production, so `LINK_TO_PLAY=on` bans for real the moment
the bot restarts. Nothing here is a rehearsal except `dry`.

## 1. Release with `LINK_TO_PLAY` unset

Release as usual (`release/x.y.z` changelog PR, then tag). The deploy runs migrations
**0074** (`identity_link_ends` and its trigger, `bans.nitrado_added`) and **0075**
(`bans.nitrado_attempted`) automatically. `LINK_TO_PLAY` unset means `off`: neither the
gate tick nor the guild sweep runs. `banTick` already removes only the entries a ban added,
and after a failed ban-list write only the names that write may have added.

Merge and deploy the `nasdara` message change (branch `feat/link-to-play-message`,
`db/messages.xml`: the first rotating message now reads "Link your gamertag at
dayzclanwars.com within 1 hour of play, or you'll be locked out until you do." and fires
on connect). That repo deploys to the live server on release, so it is the owner's call.

## 2. Announce a day ahead

The owner posts this in the announcements channel at least a day before launch. The
timestamps below are for the placeholder launch instant 2026-11-10T14:00Z (unix
1794319200). ⚠️ If the instant moves, recompute both `<t:…>` values
(`date -u -j -f "%Y-%m-%dT%H:%M:%SZ" <ISO> +%s` on macOS) before posting.

    @everyone **Link to play starts <t:1794319200:F>** (<t:1794319200:R>).

    From then on, every gamertag that plays on Clan Wars needs to be linked to a Discord
    account. You get 1 hour of play before it matters, so jump on and have a go.

    **How to link:** go to dayzclanwars.com, or use `/link` here in Discord. It takes a
    few emotes in game and about a minute.

    **Good to know:**
    - If you lose your link, by leaving this Discord or unlinking, your gamertag is
      locked out until you link again.
    - Locked out? Start linking and you are back on for an hour, once a day. Finish the
      link and you are in for good.

    See you out there.

## 3. Release setting `LINK_TO_PLAY_FROM`

Set `LINK_TO_PLAY_FROM` in `packages/domain/src/rules.ts` to the real launch instant
(the placeholder is `2026-11-10T14:00:00Z`), via its own `release/x.y.z` PR. Play before
that instant never counts toward the grace hour. Deploy and confirm the tag is checked
out. `LINK_TO_PLAY` is still unset.

## 4. Dry run

Add `LINK_TO_PLAY=dry` to `.env` (it requires `ENFORCEMENT_TICK`), then
`sudo systemctl restart clan-wars-bot`. Dry writes nothing. It posts one line per gamertag
to `OPS_CHANNEL_ID` the first time it would act, once per process: "Would ban", "Would
lift", "Would close". Read the "Would ban" lines for a few hours. Expect only gamertags
that really are unlinked and past their hour. A linked player, or a long list on the first
pass, means stop and read the spec before going on.

Cross-check one gamertag from a "Would ban" post:

    begin read only;
    select dayz_id, gamertag from identity_links where gamertag ilike '<gamertag>';
    rollback;

Zero rows is correct for an unlinked player. A row means the gate is wrong.

`dry` leaves the hourly guild sweep off: its removals are real, and dry touches nothing.

## 5. Turn it on

Set `LINK_TO_PLAY=on`, `sudo systemctl restart clan-wars-bot`. This also starts the hourly
guild sweep: right after the first full member fetch it removes linked users who left the
Discord while the bot was down, each confirmed by a Discord member fetch, at most 5 per
pass, and posts "Link sweep: removed …" to ops.

Watch the first ban:

    begin read only;
    select id, gamertag, status, attempts, banned_at, applied_at, nitrado_added, nitrado_attempted
    from bans where reason = 'unlinked' order by id desc limit 10;
    rollback;

It goes `pending` then `applied` within one `banTick` block (5 min), with the ban-list
entry in `nitrado_added`. A failed Nitrado write leaves it `pending` with `attempts` up
and the names that write may have added in `nitrado_attempted`; it retries each block and
goes `failed` after 3 attempts, removing only those names. ⚠️ Spec §8: confirm the ban actually removed a connected player
who was in game when it applied (they get dropped, or cannot rejoin). Record what you saw
in `docs/deploy/2026-09-22-hub-combat.md` §9, which has the same open question.

Watch the first lift: a banned player starts a link and the row goes `lift_pending`,
then `lifted` once `banTick` removes the ban-list entry (a row still `pending` with no
attempt yet closes with nothing to remove; one `banTick` has already tried is left until
it applies or fails). They have `LINK_TO_PLAY_LIFT_MS`
(1 hour) to finish linking, then the gate bans them again. A second attempt within 24 h
does not lift again.

## 6. Rollback

Set `LINK_TO_PLAY=off` (or remove it) and `sudo systemctl restart clan-wars-bot`. That
stops new `unlinked` rows but leaves open ones banned. Lift them by setting them
`lift_pending`, never `lifted` directly, so `banTick` removes the ban-list entry:

    update bans set status = 'lift_pending',
      nitrado_added = case when status = 'pending' then '{}' else nitrado_added end
    where reason = 'unlinked'
      and (status = 'applied' or (status = 'pending' and attempts = 0));

⚠️ A `pending` row with `attempts = 0` has never touched Nitrado, so its `nitrado_added` is
NULL, and the lift arm treats NULL as "remove both identifiers", which could free an entry
the owner added by hand. Setting it to `'{}'` makes the lift remove nothing. Do not rely on
pending rows being dry-run and skipped.

⚠️ A `pending` row with `attempts > 0` is left out on purpose: a failed write may have
landed with its response lost, so its names may be on the list, and closing it with `'{}'`
would leave them there forever. `banTick` keeps running with `LINK_TO_PLAY=off` (it is
gated on `ENFORCEMENT_TICK`) and settles each such row within 3 blocks (15 min): it
either applies (stamping what is on the list into `nitrado_added`) or goes `failed` and
removes what it attempted. Re-run the count until none is left, then run the update once
more to lift the rows that applied:

    begin read only;
    select count(*) from bans where reason = 'unlinked' and status = 'pending' and attempts > 0;
    rollback;

Run the update's count first inside `begin read only` with the same predicate. ⚠️ Only
`reason = 'unlinked'`: never touch other reasons. `banTick` removes only what each ban
added, so an entry the owner added by hand stays.

The guild sweep runs only with `on`, so `off` (and `dry`) stop it. While it runs it
confirms each missing user with a Discord member fetch before removing them, removes at
most 5 per pass, and if more than 5 look missing it removes nobody and posts one ops alert
per episode: read that as a bad member read, not as mass departure.
