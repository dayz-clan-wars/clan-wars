# Nasdara fast travel and the Hub ban (2.4.0)

Brings back what 2026-10-17 removed with the Nasdara swap: the worker's
flagpole travel boxes, the site's travel layer, the Hub combat ban and the
Hub's 200 m spacing. The mission side (sheds, hub, town doors) shipped in
`dayz-one-life/nasdara` v1.0.11.

## Before the release deploys

Nothing. The worker starts uploading `pra-teleport-hub.json` on its first
sweep after the image is rebuilt; with no change from the mission's copy
beyond the clan poles, the next restart picks it up.

## After the release is live

1. Check the worker uploaded the travel file:

       sudo docker compose logs --since 10m ingest-worker | grep "travel file"

   Expect `travel file uploaded for server 1: N active clan poles`.

2. ⚠️ Reset the Hub cursor so the ban starts at the log head. It still sits
   where the old tick stopped on 2026-10-17; `HUB_OFFENCE_MAX_AGE_MS` would
   limit a replay to 24 h, but nothing older than the switch-on should ban.
   With the bot stopped:

       sudo systemctl stop clan-wars-bot
       sudo docker compose exec -T postgres psql -U factions -d factions_live \
         -c "delete from consumer_cursors where consumer_name = 'hub-watch'"

3. Add `HUB_BAN_TICK=1` to `/opt/clan-wars/.env` (`ENFORCEMENT_TICK=1` is
   already set; the config refuses one without the other), then
   `sudo systemctl start clan-wars-bot` and look for
   `HUB_BAN_TICK on: a hit, kill or trap at the Hub is a one-hour ban.`

4. Edit the #rules post (message 1561780133776593037) to add the Hub line;
   edit, never repost.
