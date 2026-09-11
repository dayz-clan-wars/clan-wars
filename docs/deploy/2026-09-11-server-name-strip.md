# Server-name strip — runbook

The site now shows the in-game server name under the top bar on every page (the site
shell and the guide): `SERVER  <name> · <map> · confirmed N min ago`, with a Copy button.
The name is Nitrado's `settings.config.hostname` — the string players search for in the
DayZ browser — and it changes from time to time, so it is never configured: the ingest
worker re-reads it every sweep (`NitradoClient.hostname`, `apps/ingest-worker/src/sweep.ts`)
and stores it on `servers.hostname` / `servers.hostname_seen_at`. The site reads it through
one new roster export, `liveServers()` (`packages/roster/src/servers.ts`), and renders
`apps/web/app/components/server-strip.tsx` from `apps/web/lib/server-strip.ts`.

Migration 0030 adds the two columns: additive, nullable, nothing backfilled. Neither the
bot nor the worker needs stopping.

A failed Nitrado read keeps the last stored name and logs
`hostname read failed for server N`; the strip's "confirmed … ago" is how stale it is.
A server with no name yet (never swept, or a replay row) is simply not in the strip; with no
server at all the strip does not render.

## Steps

1. **Apply migration 0030** with the one-off runner from
   `docs/deploy/2026-09-02-dormancy.md`, after confirming it will apply only 0030:

       cd /opt/clan-wars && git pull --ff-only
       set -a && . ./.env && set +a && npx tsx ./migrate-live.tmp.ts

2. **Rebuild and restart the ingest worker** (it is what writes the name):

       sudo -n docker compose build -q ingest-worker && sudo -n docker compose up -d ingest-worker

3. **Confirm the first sweep wrote it:**

       sudo -n docker compose logs --since 2m ingest-worker | grep -i hostname
       psql "$DATABASE_URL" -c "select id, name, hostname, hostname_seen_at from servers"

   Expect no `hostname read failed` line and a non-null `hostname` on server 1.

4. **Deploy the web app** as usual:

       /opt/clan-wars/deploy/deploy-web.sh

5. **Acceptance:** dayzclanwars.com and dayzclanwars.com/guide both show the strip with
   the name the DayZ browser shows, and Copy puts it on the clipboard.

## Rolling back

Redeploy the previous web image; the columns can stay. Nothing else reads them.
