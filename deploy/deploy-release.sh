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
: "${FAILED_MARKER:=${STATE}.failed}"
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

# ⚠️ Without this, a deploy that fails after stop_all() re-enters the outage
# window every 2 minutes — the state file is only written on success, so the
# timer keeps seeing the same newest tag and retries the identical deploy,
# which once rollback() (Task 7) lands means a repeated drop-and-restore of
# factions_live. A human deletes the marker once the cause is fixed.
if [ -f "$FAILED_MARKER" ] && [ "$(cat "$FAILED_MARKER" 2>/dev/null)" = "$TAG" ]; then
  alert "BLOCKED" "previous deploy of $TAG failed and left $FAILED_MARKER; refusing to retry automatically until it is removed"
  exit 1
fi

# ⚠️ An edit on the box is either an emergency hotfix or a mistake. Both
# deserve a human: `git checkout` would discard either one silently.
if [ -n "$(git status --porcelain)" ]; then
  alert "BLOCKED" "working tree at $REPO is dirty; refusing to deploy $TAG"
  exit 1
fi

echo "deploying $CURRENT -> $TAG (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"

# ⚠️ Capture the currently-running image before checkout moves the tree to
# $TAG, so rollback() (Task 7) can identify what "back to $CURRENT" means.
# sudo -n docker, not bare docker: our unit runs as acab, not root (contrast
# deploy/systemd/clan-wars-backup.service, which has no User= and can use
# bare docker) — see deploy/deploy-web.sh for the house pattern.
PREV_IMAGE=$(sudo -n docker compose images -q web 2>/dev/null || true)

# ⚠️ Checkout BEFORE build, not after: building the old tree and checking
# out $TAG only afterward ships OLD web/worker code against the NEW schema —
# the "new schema + old code" failure CLAUDE.md records from 2026-09-02, now
# automated and invisible to the health check, because old code answers HTTP
# 200 happily. This checkout also rewrites live nginx and systemd config —
# /etc symlinks into this tree, and this host serves three other production
# sites — which is why nginx -t is checked, further down, before nginx ever
# reloads it. Still in the preflight, before any stop: build is the longest
# step, and a failed build reverts the tree and aborts with nothing stopped.
run git checkout --quiet "$TAG"
if ! run sudo -n docker compose build -q web ingest-worker; then
  run git checkout --quiet "$CURRENT"
  alert "BLOCKED" "build failed for $TAG; reverted to $CURRENT, nothing stopped"
  exit 1
fi

DUMP="$BACKUPS/predeploy-$TAG.sql.gz"

stop_all

# Same idiom as deploy/backup/backup-factions-live.sh: dump inside the
# container, write .part, rename only on success.
run mkdir -p "$BACKUPS"
if [ "$DRY_RUN" = "0" ]; then
  # ⚠️ Not left to bare `set -e`: a pg_dump error, a full disk, or a failed
  # mv must restart services and alert, not exit instantly with production
  # down and nothing said.
  if ! { sudo -n docker exec "$CONTAINER" pg_dump -U factions -d factions_live --no-owner \
      | gzip -9 > "$DUMP.part"; } || ! mv "$DUMP.part" "$DUMP"; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed to complete; restarting services, NOT deploying"
    printf '%s\n' "$TAG" > "$FAILED_MARKER"
    start_all
    exit 1
  fi

  # ⚠️ Verify BEFORE touching the schema. This is the last moment where
  # aborting costs only the downtime already spent — after the migration
  # there is no way back except this file.
  if ! gzip -t "$DUMP" || [ "$(stat -c %s "$DUMP")" -lt 1000 ]; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed verification; restarting services, NOT deploying"
    printf '%s\n' "$TAG" > "$FAILED_MARKER"
    start_all
    exit 1
  fi
else
  printf 'DRY: pg_dump → %s\n' "$DUMP"
fi

# ⚠️ Every failure past this point must reach rollback(), not abort with the
# services stopped and nothing said. rollback() (Task 7) disarms this trap
# on entry so it cannot recurse into itself.
trap 'rollback "unhandled failure at line $LINENO"' ERR

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
# ⚠️ Only reached once start_all() itself succeeds — a stale marker here
# would silently block the next real deploy of this same tag forever.
run rm -f "$FAILED_MARKER"
