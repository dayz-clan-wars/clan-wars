# Deploy: an active clan's flagpole is a fast-travel point (2026-09-09)

The ingest worker now projects a second file onto the game server, next to
`faction-supplies.json`: **`pra-teleport-hub.json`**, the fast-travel mod's config.
It is the vendored template (`apps/ingest-worker/assets/teleport-hub.template.json`,
a verbatim copy of `livonia/custom/pra-teleport-hub.json` — 209 boxes, the Hub's
arrival spots) plus one 4 × 3 × 4 m box at the declared pole of every clan that is
**active with its flag up**. Reserved, dormant and raided clans have no box.
Same contract as supplies: regenerate every sweep, hash, upload on difference, drift
detection against the observed remote size/mtime (`apps/ingest-worker/src/projection-upload.ts`,
shared by both files). Migration 0029 adds `travel_uploads`, the second file's
hash/baseline row.

⚠️ **The game reads this file at server restart.** A clan activating at 14:00 gets its
door at the next restart, not at the next sweep. The worker's log line says so.

⚠️ **The template must be the file the server holds.** Checked on 2026-09-09: the
server's `pra-teleport-hub.json` is 64,890 bytes, byte-identical in size to the repo copy.
If the operator ever hand-edits the deployed file, edit the template too, or the next
sweep overwrites the edit (and logs drift).

## Steps

1. **Apply migration 0029** (`travel_uploads`, additive, nothing backfilled) with the
   one-off runner from `docs/deploy/2026-09-02-dormancy.md`:

       cd /opt/clan-wars && git pull --ff-only
       set -a && . ./.env && set +a && npx tsx ./migrate-live.tmp.ts

   Before running it, confirm the migrator will apply only 0029 (see that runbook's
   `__drizzle_migrations` check).

2. **Rebuild and restart the ingest worker** (it runs under compose here, not systemd):

       sudo -n docker compose build -q ingest-worker && sudo -n docker compose up -d ingest-worker

3. **Watch the first sweep:**

       sudo -n docker compose logs --since 2m ingest-worker | grep -i travel

   Expect one `travel file uploaded for server 1: N active clan poles` line. With no
   active clan the upload is the template, byte-for-byte what was there apart from
   whitespace, and the `travel_uploads` row is written:

       sudo -n docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -At \
         -c "select server_id, uploaded_at, remote_size from travel_uploads"

4. **Verify in game after the next scheduled restart:** stand beside an active clan's
   flagpole, relog, and arrive at the Hub. Any fixed point still works as before.

## Rollback

Delete the `travel:` block from `apps/ingest-worker/src/main.ts`'s sweep call (or
revert the merge), rebuild the worker, and re-upload the template by hand if a clan
box should be removed before the next natural change. The `travel_uploads` table is
harmless to leave.
