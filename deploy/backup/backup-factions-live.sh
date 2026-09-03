#!/usr/bin/env bash
# Nightly logical backup of factions_live.
#
# ⚠️ factions_live is NOT reconstructible from the game server's logs. The
# `events` table is — the ingest worker re-reads Nitrado's ADM files — but
# `factions`, `faction_members`, `identity_links` and `faction_events` exist
# ONLY here. Losing this database means every player redoes `/link`, every
# roster is gone, and the feed's history is gone permanently: a transition's
# own evidence IS the log (see CLAUDE.md), so nothing can reconstruct it.
set -euo pipefail

DEST=/var/backups/clan-wars
CONTAINER=clan-wars-postgres-1
KEEP=14

mkdir -p "$DEST"

# ⚠️ pg_dump inside the container, not from the host. The host has no psql
# client guaranteed, and the port is now bound to loopback only — reaching it
# from outside Docker is deliberately not a thing this script relies on.
#
# ⚠️ Write to a .part file and rename only on success. A backup directory
# whose newest file is a truncated dump from an interrupted run is worse than
# one with no file at all: it looks like a backup and restores as garbage.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/factions_live-$STAMP.sql.gz"

docker exec "$CONTAINER" pg_dump -U factions -d factions_live --no-owner \
  | gzip -9 > "$OUT.part"
mv "$OUT.part" "$OUT"

# ⚠️ Verify the dump is readable and non-trivial before rotating anything out.
# Rotation that runs regardless of dump success will happily delete 14 good
# backups over 14 nights of a silently failing dump.
if ! gzip -t "$OUT"; then
  echo "backup FAILED gzip integrity check: $OUT" >&2
  exit 1
fi
SIZE=$(stat -c %s "$OUT")
if [ "$SIZE" -lt 1000 ]; then
  echo "backup implausibly small (${SIZE}B), refusing to rotate: $OUT" >&2
  exit 1
fi

# Rotate: keep the newest $KEEP, delete the rest.
ls -1t "$DEST"/factions_live-*.sql.gz | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "backup ok: $OUT (${SIZE}B), $(ls -1 "$DEST"/factions_live-*.sql.gz | wc -l) kept"
