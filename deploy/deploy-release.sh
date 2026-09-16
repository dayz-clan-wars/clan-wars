#!/usr/bin/env bash
# Deploy the newest release tag to this host, end to end.
#
#   deploy/deploy-release.sh [--dry-run]
#
# Runs from clan-wars-deploy.timer every 2 minutes. Exits 0 and says nothing
# when there is no new tag — see ⚠️ on alert() below.
#
# The sequence and its reasoning: docs/superpowers/specs/2026-09-16-auto-deploy-design.md
set -euo pipefail

# --- configuration ---

# ⚠️ Overridable so `--dry-run` can be exercised off the production host; the
# systemd unit sets none of these, so a real deploy always gets the defaults.
: "${REPO:=/opt/clan-wars}"
: "${STATE:=/var/lib/clan-wars/deployed-tag}"
: "${LOCK:=/var/lock/clan-wars-deploy}"
: "${BACKUPS:=/var/backups/clan-wars}"
CONTAINER=clan-wars-postgres-1
PNPM=/home/acab/.local/bin/pnpm

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --- functions (every function lives above anything that may call one; see ⚠️ below) ---
#
# ⚠️ bash binds a function when its definition line EXECUTES, not when the
# file is parsed. Tasks 5-8 append a rollback() here that calls health_ok()
# and the other helpers below — if a function definition sat after the
# executable flow instead, a rollback triggered mid-deploy could reach that
# line before it ever ran, hit "command not found" (exit 127), and be read
# as "the rollback failed" — reporting CRITICAL after a rollback that
# actually succeeded. Keep every function above anything that may call one.

# ⚠️ Every mutating command goes through run(). --dry-run prints and executes
# nothing, which is the only reviewable artifact this script has.
run() {
  if [ "$DRY_RUN" = "1" ]; then printf 'DRY: %s\n' "$*"; else "$@"; fi
}

state_read()  { cat "$STATE" 2>/dev/null || true; }
state_write() { run mkdir -p "$(dirname "$STATE")"; run sh -c "printf '%s\n' '$1' > '$STATE'"; }

# ⚠️ Never called on a no-op. At a 2-minute interval that is 720 messages a
# day, and an alert channel nobody reads is not an alert channel.
alert() {
  local level="$1" text="$2"
  printf '[%s] %s\n' "$level" "$text"
  [ -n "${DEPLOY_WEBHOOK_URL:-}" ] || return 0
  run curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"content": "**%s** %s"}' "$level" "$text")" \
    "$DEPLOY_WEBHOOK_URL" >/dev/null || true
}

stop_all() {
  # ⚠️ All three write to factions_live — the bot every tick, web through
  # packages/roster, the worker through events and the supply upload. The
  # automatic restore in rollback() is only lossless because none of them is
  # running between the dump and the restore.
  # ⚠️ systemctl, never pkill: ~15 dayzonelife.com services match
  # `src/main.ts`-style patterns, and pkill here is a site-outage command.
  run sudo -n systemctl stop clan-wars-bot
  run sudo -n docker compose stop web ingest-worker
}

start_all() {
  run sudo -n docker compose up -d web ingest-worker
  run sudo -n systemctl start clan-wars-bot
}

# --- executable flow ---

# ⚠️ flock, not a pidfile. A deploy that outruns the 2-minute timer must not
# have a second copy stopping services underneath it.
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO"
set -a; . ./.env; set +a

run git fetch --tags --prune origin

CURRENT=$(state_read)
PLAN=$("$PNPM" deploy:select "$CURRENT")
TAG=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag"] or "")')
HOST_CONFIG=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["touchesHostConfig"])')
MIGRATIONS=$(printf '%s' "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["touchesMigrations"])')

[ -n "$TAG" ] || exit 0
[ "$TAG" != "$CURRENT" ] || exit 0

# ⚠️ An edit on the box is either an emergency hotfix or a mistake. Both
# deserve a human: `git checkout` would discard either one silently.
if [ -n "$(git status --porcelain)" ]; then
  alert "BLOCKED" "working tree at $REPO is dirty; refusing to deploy $TAG"
  exit 1
fi

echo "deploying $CURRENT -> $TAG (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"

# ⚠️ Build BEFORE stopping anything. This is the longest step; inside the
# outage window it would roughly triple the downtime for no benefit. A failed
# build aborts with nothing stopped and nothing changed.
PREV_IMAGE=$(docker compose images -q web 2>/dev/null || true)
run sudo -n docker compose build -q web

DUMP="$BACKUPS/predeploy-$TAG.sql.gz"

stop_all

# Same idiom as deploy/backup/backup-factions-live.sh: dump inside the
# container, write .part, rename only on success.
run mkdir -p "$BACKUPS"
if [ "$DRY_RUN" = "0" ]; then
  docker exec "$CONTAINER" pg_dump -U factions -d factions_live --no-owner \
    | gzip -9 > "$DUMP.part"
  mv "$DUMP.part" "$DUMP"

  # ⚠️ Verify BEFORE touching the schema. This is the last moment where
  # aborting costs only the downtime already spent — after the migration
  # there is no way back except this file.
  if ! gzip -t "$DUMP" || [ "$(stat -c %s "$DUMP")" -lt 1000 ]; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed verification; services stopped, NOT deploying"
    start_all
    exit 1
  fi
fi

# ⚠️ From here on, every failure goes through rollback() (Task 7).
# This checkout rewrites live nginx and systemd config: /etc symlinks into
# this tree, and this host serves three other production sites.
run git checkout --quiet "$TAG"

if ! run sudo -n nginx -t; then
  rollback "nginx -t failed after checking out $TAG"
fi

if ! run "$PNPM" db:migrate --apply --production; then
  rollback "migration failed on $TAG"
fi

run sudo -n systemctl daemon-reload
# ⚠️ reload, never restart: a restart on a bad config takes down all four
# sites, where a failed reload leaves the old config live.
run sudo -n systemctl reload nginx

start_all
