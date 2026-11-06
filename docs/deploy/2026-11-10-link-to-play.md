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

Release as usual (`release/x.y.z` changelog PR, then tag). The deploy runs migration
**0074** (`identity_link_ends` and its trigger, `bans.nitrado_added`) automatically.
`LINK_TO_PLAY` unset means `off`: the gate tick does not run, but `banTick` already
removes only the entries a ban added, and the hourly guild sweep already runs.

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

## 5. Turn it on

Set `LINK_TO_PLAY=on`, `sudo systemctl restart clan-wars-bot`.

Watch the first ban:

    begin read only;
    select id, gamertag, status, banned_at, applied_at, nitrado_added
    from bans where reason = 'unlinked' order by id desc limit 10;
    rollback;

It goes `pending` then `applied` within one `banTick` block (5 min), with the ban-list
entry in `nitrado_added`. ⚠️ Spec §8: confirm the ban actually removed a connected player
who was in game when it applied (they get dropped, or cannot rejoin). Record what you saw
in `docs/deploy/2026-09-22-hub-combat.md` §9, which has the same open question.

Watch the first lift: a banned player starts a link and the row goes `lift_pending`,
then `lifted` once `banTick` removes the ban-list entry. They have `LINK_TO_PLAY_LIFT_MS`
(1 hour) to finish linking, then the gate bans them again. A second attempt within 24 h
does not lift again.

## 6. Rollback

Set `LINK_TO_PLAY=off` (or remove it) and `sudo systemctl restart clan-wars-bot`. That
stops new `unlinked` rows but leaves open ones banned. Lift them by setting them
`lift_pending`, never `lifted` directly, so `banTick` removes the ban-list entry:

    update bans set status = 'lift_pending'
    where reason = 'unlinked' and status in ('pending', 'applied');

Run the count first inside `begin read only` with the same predicate. ⚠️ Only
`reason = 'unlinked'`: never touch other reasons. `banTick` removes only what each ban
added, so an entry the owner added by hand stays.

The guild sweep keeps running while `off`. It removes at most 5 linked users per pass, and
if more than 5 look missing it removes nobody and posts one ops alert per episode: read
that as a bad member read, not as mass departure.
