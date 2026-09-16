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

# ⚠️ `systemctl is-active` is NOT a health check, and believing it is is the
# easiest mistake available here. CLAUDE.md: the bot holds no eager database
# connection and every tick is individually try/caught, so a bot pointed at a
# dead database reports `active (running)` forever with the whole data path
# down. The HTTP check is the load-bearing one — web reads through
# packages/roster to the database, so a 200 exercises the entire path.
# sudo -n docker, same as everywhere else in this file: the unit runs as acab.
health_ok() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if sudo -n docker compose ps postgres --format '{{.Health}}' 2>/dev/null | grep -q healthy \
      && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3020/ \
      && sudo -n docker exec "$CONTAINER" psql -U factions -d factions_live -X -tAc 'select 1' >/dev/null 2>&1 \
      && systemctl is-active --quiet clan-wars-bot
    then
      return 0
    fi
    sleep 5
  done
  return 1
}

# ⚠️ Non-fatal, always: this is bookkeeping, and a failure to write it must
# never decide whether production runs. Same contract as the two inline marker
# writes in the dump section — $FAILED_MARKER lives under /var/lib/clan-wars,
# created as root while this unit runs as acab, so a permission failure here is
# reachable, not hypothetical. Losing it costs a retry, not an outage.
# Goes through run() so --dry-run stays a total no-op.
mark_failed() {
  # ${TAG:-} rather than $TAG: set -u is on, and an unbound variable here would
  # abort a rollback mid-way instead of costing only the marker.
  run sh -c "printf '%s\n' '${TAG:-}' > '$FAILED_MARKER'" \
    || alert "CRITICAL" "could not write $FAILED_MARKER; this deploy will retry in 2 minutes"
}

# ⚠️ The end of the line for an automated deploy: stop, stay stopped, exit 2.
# Do NOT retry. A deploy loop thrashing against a database it cannot read is how
# the 2026-09-01 duplicate-DM incident reaches a real player; a stopped bot is a
# visible outage a human fixes, which is strictly better. The marker is written
# here too — without it the timer sees the same newest tag in 2 minutes and
# repeats the whole drop-and-restore of factions_live, indefinitely.
# Separate from rollback() only so every failing step inside it lands here
# identically instead of falling out through `set -e` with an arbitrary code.
rollback_abort() {
  stop_all || alert "CRITICAL" "could not stop services during a failed rollback; production may be UP on a half-restored state"
  mark_failed
  alert "CRITICAL" "ROLLBACK FAILED after: $1 — services STOPPED, needs a human. Dump: ${DUMP:-none}"
  exit 2
}

# Restore the previous release completely: code, image, host config, schema.
#
# ⚠️ This is lossless ONLY because stop_all() ran before the dump was taken.
# No writer existed between dump and restore, so no player action can be
# destroyed. If a future change starts the services earlier, this function
# becomes a data-loss event and must be reconsidered.
#
# ⚠️ This function NEVER returns — exit 1 when the rollback succeeded, exit 2
# when it did not. That is an invariant of its CALL SITES, not of its own
# logic: they are written as `if ! run … ; then rollback "…"; fi`, so a return
# would fall through to daemon-reload, `reload nginx` and start_all, bringing
# production up on a half-applied migration and reporting success.
#
# ⚠️ Every variable it reads is defaulted (`${VAR:-}`). set -u is on, and an
# unbound variable inside the rollback would abort it mid-way — with production
# stopped — rather than reaching either exit.
rollback() {
  # ⚠️ FIRST statement, before anything that can fail: the flow arms
  # `trap 'rollback …' ERR`, so a failure inside the rollback would otherwise
  # re-enter the rollback recursively, stopping and dropping again each time.
  trap - ERR

  local reason="$1"
  alert "ROLLING BACK" "$reason"

  # ⚠️ Abort rather than restore if the stop did not take: the restore below is
  # lossless only while nothing is writing, and a bot still ticking against
  # factions_live during a drop-and-restore is exactly the data-loss case the
  # comment at the top of this function rules out.
  if ! stop_all; then
    rollback_abort "$reason (services would not stop; database NOT touched)"
  fi

  if [ "$DRY_RUN" = "0" ]; then
    # ⚠️ Terminate anything still holding the database, or DROP blocks forever —
    # a rollback that hangs here leaves production stopped with no timeout.
    # Each step is checked: under a disarmed ERR trap a bare failure would exit
    # with psql's status and never reach rollback_abort's alert, so a failed
    # restore would look like an ordinary error instead of "the database is
    # gone and a human is needed".
    if ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c \
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'factions_live'" >/dev/null \
      || ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c "drop database factions_live" \
      || ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c "create database factions_live" \
      || ! { gzip -dc "${DUMP:-}" | sudo -n docker exec -i "$CONTAINER" psql -U factions -d factions_live -X -q; }
    then
      rollback_abort "$reason (restoring factions_live from ${DUMP:-none} FAILED — the database may be empty)"
    fi
  fi

  # ⚠️ Back to the exact ref the deploy started from, not to the tag $CURRENT:
  # $CURRENT is empty on a first run and may have been pruned by the fetch, and
  # checking out a tag leaves the repo detached — which `git status --porcelain`
  # calls clean, so the dirty-tree guard would never catch it. Same reasoning as
  # the build-failure revert above. This checkout also restores live nginx and
  # systemd config: /etc symlinks into this tree.
  if [ -n "${PREV_REF:-}" ] && ! run git checkout --quiet "${PREV_REF}"; then
    rollback_abort "$reason (could not check out ${PREV_REF}; host config is still $TAG's)"
  fi

  # ⚠️ The tag to restore is whatever compose calls this service's image — it is
  # derived from the compose project name, NOT necessarily `clan-wars-web:latest`,
  # so it is asked for rather than assumed; a wrong tag here would silently leave
  # the NEW image running while reporting success. Resolved AFTER the checkout,
  # so the name comes from the old tree's compose file.
  # ⚠️ web only. The build step builds web AND ingest-worker, but $PREV_IMAGE
  # captures web's image alone, so a rollback leaves the worker on the NEW image
  # against the restored schema. The worker writes events and the supply file;
  # this gap is deliberate and unhandled here — see the task report.
  if [ -n "${PREV_IMAGE:-}" ]; then
    local WEB_IMAGE
    WEB_IMAGE=$(sudo -n docker compose config --images web 2>/dev/null | head -1 || true)
    if [ -n "$WEB_IMAGE" ] && ! run sudo -n docker tag "${PREV_IMAGE}" "$WEB_IMAGE"; then
      rollback_abort "$reason (could not retag $WEB_IMAGE to ${PREV_IMAGE}; the NEW web image would start)"
    fi
  fi

  # ⚠️ nginx -t before the reload, never after: this host serves three other
  # production sites from the same nginx. A reload of a bad config is refused and
  # leaves the old one live, but testing first is what keeps the failure legible.
  if ! run sudo -n systemctl daemon-reload \
    || ! run sudo -n nginx -t \
    || ! run sudo -n systemctl reload nginx
  then
    rollback_abort "$reason (host config would not reload at ${PREV_REF:-HEAD})"
  fi

  if ! start_all; then
    rollback_abort "$reason (services would not start on the restored release)"
  fi

  # ⚠️ After start_all, so bookkeeping can never strand the outage, and on the
  # SUCCESS path too: the tag still deploys cleanly from the timer's point of
  # view, and without the marker it re-enters this whole outage window — stop,
  # dump, and another drop-and-restore of factions_live — every 2 minutes.
  mark_failed

  if [ "$DRY_RUN" = "1" ] || health_ok; then
    alert "ROLLED BACK" "restored ${CURRENT:-the previous release} after: $reason"
    exit 1
  fi

  rollback_abort "$reason (health check failed on the restored release)"
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
#
# ⚠️ Revert to the exact ref we were on, not to the tag $CURRENT: $CURRENT is
# empty on a first run and may have been pruned by the fetch above, and
# checking out a tag would silently leave the repo detached — which
# `git status --porcelain` reports as clean, so the dirty-tree guard would
# never catch it.
PREV_REF=$(git rev-parse HEAD)
run git checkout --quiet "$TAG"
if ! run sudo -n docker compose build -q web ingest-worker; then
  run git checkout --quiet "$PREV_REF" || alert "CRITICAL" "build failed for $TAG AND the revert to $PREV_REF failed; tree is at $TAG with nothing stopped — needs a human"
  alert "BLOCKED" "build failed for $TAG; reverted to $PREV_REF, nothing stopped"
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
    start_all
    # ⚠️ After start_all, and never fatal: this is bookkeeping, and a failure
    # to write it must not leave production stopped. The cost of losing it is
    # a retry two minutes later, not an outage. $FAILED_MARKER lives under
    # /var/lib/clan-wars, created as root while the unit runs as acab — a
    # permission failure here is reachable, not hypothetical.
    printf '%s\n' "$TAG" > "$FAILED_MARKER" || alert "CRITICAL" "could not write $FAILED_MARKER; this deploy will retry in 2 minutes"
    exit 1
  fi

  # ⚠️ Verify BEFORE touching the schema. This is the last moment where
  # aborting costs only the downtime already spent — after the migration
  # there is no way back except this file.
  if ! gzip -t "$DUMP" || [ "$(stat -c %s "$DUMP")" -lt 1000 ]; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed verification; restarting services, NOT deploying"
    start_all
    # ⚠️ Same as above: never fatal, and after start_all — bookkeeping must
    # not be able to strand the outage.
    printf '%s\n' "$TAG" > "$FAILED_MARKER" || alert "CRITICAL" "could not write $FAILED_MARKER; this deploy will retry in 2 minutes"
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

# ⚠️ The gate: state is recorded and the marker cleared ONLY after health_ok
# passes, so a bad health result can never land on a cleared marker — the
# marker is what stops a failed deploy re-entering the outage window every
# 2 minutes. On a real failure this falls through to rollback() (Task 7),
# never to a bare exit — see the ⚠️ on the ERR trap above.
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY: health_ok (skipped)"
else
  if health_ok; then
    state_write "$TAG"
    # ⚠️ Only reached once state_write has succeeded — a stale marker here
    # would silently block the next real deploy of this same tag forever.
    run rm -f "$FAILED_MARKER"
    alert "DEPLOYED" "$TAG is live (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"
  else
    rollback "health check failed after deploying $TAG"
  fi
fi
