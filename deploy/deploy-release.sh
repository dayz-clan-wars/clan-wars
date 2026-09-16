#!/usr/bin/env bash
# Deploy the newest release tag to this host, end to end.
#
#   deploy/deploy-release.sh [--dry-run]
#
# Runs from clan-wars-deploy.timer every 2 minutes. Exits 0 and says nothing
# when there is no new tag — see ⚠️ on alert() below.
#
# The sequence and its reasoning: docs/superpowers/specs/2026-09-16-auto-deploy-design.md
#
# ⚠️ -E, not just -e. Without it bash does NOT inherit the ERR trap into shell
# functions — and every mutating statement after the trap is armed is a call to
# run() or to a helper, i.e. inside a function. So daemon-reload, `reload nginx`
# and the service starts would all exit silently with no rollback, no alert and
# no marker, AFTER the migration had applied; the timer would then re-run two
# minutes later and re-dump a post-migration database over the good pre-deploy
# dump, destroying the only artifact the rollback depends on.
set -Eeuo pipefail

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
# Matches KEEP in deploy/backup/backup-factions-live.sh — these dumps share that
# script's volume, and it only ever rotates its own `factions_live-*` files.
KEEP_PREDEPLOY=14

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
  # ⚠️ `|| return 1` on every line, in all four helpers. Called in a condition
  # (`if ! stop_all`), set -e is SUSPENDED for the whole body, so without this
  # the function's status is its LAST command's only: a failed bot stop followed
  # by a successful `compose stop` would return 0, and rollback()'s guard —
  # written precisely to catch a bot still ticking during a drop-and-restore —
  # would miss the one failure it exists for.
  run sudo -n systemctl stop clan-wars-bot || return 1
  run sudo -n docker compose stop web ingest-worker || return 1
}

# ⚠️ Split from the bot start on purpose; see the ⚠️ at the tail of the flow.
# On a deploy the bot starts LAST, after the services have been proved healthy,
# because it is the only writer in that window whose writes a rollback cannot
# undo safely.
start_services() {
  run sudo -n docker compose up -d web ingest-worker || return 1
}

start_bot() {
  run sudo -n systemctl start clan-wars-bot || return 1
}

# Everything at once. Used where the release is NOT on trial: the pre-deploy
# abort paths (nothing has been changed yet) and rollback() (the old release is
# back, and staging the checks would buy nothing).
start_all() {
  start_services || return 1
  start_bot || return 1
}

# ⚠️ The preflight's undo. The install is part of it, not an afterthought
# (Ruling 17): reverting the tree without reverting node_modules leaves the host
# tree at $PREV_REF and its dependencies at $TAG's, and the bot — which is not
# containerised and runs straight from this tree — is what finds out.
revert_tree() {
  run git checkout --quiet "${PREV_REF:-}" || return 1
  run "$PNPM" install --frozen-lockfile || return 1
}

# ⚠️ `systemctl is-active` is NOT a health check, and believing it is is the
# easiest mistake available here. CLAUDE.md: the bot holds no eager database
# connection and every tick is individually try/caught, so a bot pointed at a
# dead database reports `active (running)` forever with the whole data path
# down. The HTTP check is the load-bearing one — web reads through
# packages/roster to the database, so a 200 exercises the entire path.
# sudo -n docker, same as everywhere else in this file: the unit runs as acab.
# ⚠️ Deliberately does NOT check the bot: on a deploy this runs while the bot is
# still stopped, which is what keeps the health path's rollback cheap.
services_ok() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if sudo -n docker compose ps postgres --format '{{.Health}}' 2>/dev/null | grep -q healthy \
      && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3020/ \
      && sudo -n docker exec "$CONTAINER" psql -U factions -d factions_live -X -tAc 'select 1' >/dev/null 2>&1
    then
      return 0
    fi
    sleep 5
  done
  return 1
}

# Did the bot actually come up? Takes the timestamp captured immediately before
# the start, so the journal scan cannot match a previous run's line.
#
# ⚠️ `is-active` is NOT a readiness signal here, and sampling it at t≈0 proves
# nothing at all: systemd reports a Type=simple unit active the instant it forks,
# before the bot has loaded config, taken the advisory lock or logged in to
# Discord. Worse, the instance-lock refusal (apps/bot/src/instance-lock.ts)
# exits 0 deliberately, so `Restart=on-failure` leaves it exited — and a t≈0
# sample still says active, which would alert DEPLOYED with no bot running.
# `bot ready as <tag>` is logged once, unconditionally, from the `clientReady`
# handler in apps/bot/src/discord.ts, AFTER the Discord login: the first moment
# the bot genuinely exists.
bot_ok() {
  local since="$1" deadline=$((SECONDS + 90))

  # ⚠️ Fail CLOSED is wrong here. If acab cannot read this unit's journal, the
  # grep below never matches and every healthy deploy rolls back — dropping and
  # restoring factions_live each time. So probe the journal once first, and fall
  # back if it is unreadable.
  if ! journalctl -u clan-wars-bot -n 1 >/dev/null 2>&1; then
    # ⚠️ The weaker check, knowingly, and only because the alternative is a
    # rollback loop: sleep FIRST and sample `is-active` at the END of the window,
    # so at least a bot that died or refused during startup has had time to do
    # it. It still cannot distinguish "logged in to Discord" from "forked".
    alert "WARN" "cannot read clan-wars-bot's journal; falling back to a late is-active check, which cannot see a bot that forked but never logged in"
    sleep 60
    if systemctl is-active --quiet clan-wars-bot; then return 0; fi
    return 1
  fi

  while [ "$SECONDS" -lt "$deadline" ]; do
    if journalctl -u clan-wars-bot --since "$since" 2>/dev/null | grep -q 'bot ready as'; then
      return 0
    fi
    sleep 5
  done
  return 1
}

# The whole path, for rollback(): it brings everything back up at once, so there
# is nothing to be gained by staging the checks the way the deploy does. Takes
# the same pre-start timestamp bot_ok needs.
health_ok() {
  services_ok && bot_ok "$1"
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

# Restore the previous release completely: code, deps, images, host config, schema.
#
# ⚠️ Losslessness is NOT a property of this function — it is a property of the
# call site, and only two of them have it:
#   - `nginx -t failed`  and  `migration failed`: stop_all() ran before the dump
#     and nothing has started since, so no writer existed between dump and
#     restore and no player action can be destroyed.
#   - the HEALTH path: `web` and `ingest-worker` have been up for as long as
#     services_ok ran (up to 90 s), and the restore DISCARDS whatever they wrote
#     in that window. That is accepted, bounded damage: `web` writes only on an
#     explicit user action, and `ingest-worker`'s writes are re-ingested from the
#     ADM logs once its cursor rewinds. The bot is deliberately NOT running in
#     that window — its writes are the ones that would be neither bounded nor
#     recoverable (`notifyCompleted` DMs before it marks, so rewinding a mark
#     reproduces the 2026-09-01 duplicate-DM incident automatically).
#   - the BOT path (`bot_ok` failed): the same window, plus a bot that was asked
#     to start and never reached `active`. A bot that never came up did not tick,
#     so in practice it wrote nothing; this is the one call site where that is an
#     inference rather than a guarantee, and it is the price of checking the bot
#     at all.
# ⚠️ So: if a future change starts the BOT any earlier than the tail of the flow
# does today, this function becomes a data-loss event and must be reconsidered.
#
# ⚠️ This function NEVER returns — exit 1 when the rollback succeeded, exit 2
# when it did not. That is an invariant of its CALL SITES, not of its own
# logic: they are written as `if ! run … ; then rollback "…"; fi`, so a return
# would fall through to daemon-reload, `reload nginx` and the service starts,
# bringing production up on a half-applied migration and reporting success.
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
    # ⚠️ Terminate anything still holding the database, or DROP blocks forever.
    # Each step is checked: under a disarmed ERR trap a bare failure would exit
    # with psql's status and never reach rollback_abort's alert, so a failed
    # restore would look like an ordinary error instead of "the database is
    # gone and a human is needed".
    #
    # ⚠️ -v ON_ERROR_STOP=1 on the restore is load-bearing. psql reading a
    # script from stdin exits 0 even when individual statements fail, so a dump
    # that decompresses but whose COPY blocks error out would restore PARTIALLY
    # and report success — and nothing downstream could catch it: `select 1`
    # succeeds against a half-empty database and an empty-roster page still
    # answers HTTP 200.
    #
    # ⚠️ A `timeout` around this was considered and REJECTED. A restore killed
    # part-way leaves factions_live half-populated, which passes `select 1`,
    # serves 200, and looks live while being silently wrong — the exact failure
    # ON_ERROR_STOP exists to prevent. An indefinite hang is visible, and the
    # ROLLING BACK alert above has already fired to say a human should look.
    # Do not add one.
    if ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c \
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'factions_live'" >/dev/null \
      || ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c "drop database factions_live" \
      || ! sudo -n docker exec "$CONTAINER" psql -U factions -d factions -X -c "create database factions_live" \
      || ! { gzip -dc "${DUMP:-}" | sudo -n docker exec -i "$CONTAINER" \
               psql -U factions -d factions_live -X -q -v ON_ERROR_STOP=1; }
    then
      rollback_abort "$reason (restoring factions_live from ${DUMP:-none} FAILED — the database may be empty)"
    fi
  fi

  # ⚠️ Back to the exact ref the deploy started from, not to the tag $CURRENT:
  # $CURRENT is empty on a first run, and may have been pruned by the fetch
  # above. (It is NOT about detachment: $PREV_REF is a bare SHA, so HEAD ends up
  # equally detached either way — and after the first deploy it already is.)
  # Same reasoning as the build-failure revert below. This checkout also restores
  # live nginx and systemd config: /etc symlinks into this tree.
  if [ -n "${PREV_REF:-}" ] && ! run git checkout --quiet "${PREV_REF}"; then
    rollback_abort "$reason (could not check out ${PREV_REF}; host config is still $TAG's)"
  fi

  # ⚠️ Ruling 17. The bot is NOT containerised: it runs from this tree against
  # host node_modules, and nothing else installs them. Rolling the tree back
  # without rolling the dependencies back starts a bot importing whatever the
  # failed release left behind. Before anything starts, and fatal.
  if ! run "$PNPM" install --frozen-lockfile; then
    rollback_abort "$reason (pnpm install failed at ${PREV_REF:-HEAD}; node_modules still belongs to $TAG)"
  fi

  # ⚠️ The tag to restore is whatever compose calls each service's image — it is
  # derived from the compose project name, NOT necessarily `clan-wars-web:latest`,
  # so it is asked for rather than assumed; a wrong tag here would silently leave
  # the NEW image running while reporting success. Resolved AFTER the checkout,
  # so the names come from the old tree's compose file.
  # ⚠️ BOTH services, since the deploy builds both (Ruling 10). Restoring web
  # alone would leave ingest-worker on the NEW image against the RESTORED OLD
  # schema — new-code/old-schema, the 2026-09-02 failure — and no health check
  # can see it, because the worker serves no HTTP.
  # ⚠️ An empty value is NOT skipped. $PREV_IMAGE_* comes back empty when no
  # container existed at capture time — exactly the state a previous failed
  # deploy leaves — and the compose lookup below comes back empty when `sudo -n`
  # is refused. Either way a rollback that cannot name what it is rolling back to
  # is not a rollback, and continuing would start the NEW image while alerting
  # success. Abort instead: a stopped service is a visible outage.
  # ⚠️ `docker compose config --images` runs even under --dry-run (read-only, but
  # privileged), so a dry run is not runnable unprivileged — same precedent as
  # the `compose images -q` capture in the flow below.
  local svc prev target
  for svc in web ingest-worker; do
    case "$svc" in
      web) prev="${PREV_IMAGE_WEB:-}" ;;
      *)   prev="${PREV_IMAGE_WORKER:-}" ;;
    esac
    if [ -z "$prev" ]; then
      rollback_abort "$reason (no previous image was captured for $svc; the NEW image would keep running)"
    fi
    target=$(sudo -n docker compose config --images "$svc" 2>/dev/null | head -1 || true)
    if [ -z "$target" ]; then
      rollback_abort "$reason (could not resolve the compose image name for $svc; the NEW image would keep running)"
    fi
    if ! run sudo -n docker tag "$prev" "$target"; then
      rollback_abort "$reason (could not retag $target to $prev; the NEW $svc image would start)"
    fi
  done

  # ⚠️ nginx -t before the reload, never after: this host serves three other
  # production sites from the same nginx. A reload of a bad config is refused and
  # leaves the old one live, but testing first is what keeps the failure legible.
  if ! run sudo -n systemctl daemon-reload \
    || ! run sudo -n nginx -t \
    || ! run sudo -n systemctl reload nginx
  then
    rollback_abort "$reason (host config would not reload at ${PREV_REF:-HEAD})"
  fi

  # ⚠️ Captured BEFORE the start: bot_ok scans the journal from this instant, so
  # taking it afterwards could miss the `bot ready as` line it is waiting for,
  # and taking it earlier could match the line from the run we just stopped.
  local since
  since=$(date '+%Y-%m-%d %H:%M:%S')

  if ! start_all; then
    rollback_abort "$reason (services would not start on the restored release)"
  fi

  # ⚠️ After start_all, so bookkeeping can never strand the outage, and on the
  # SUCCESS path too: the tag still deploys cleanly from the timer's point of
  # view, and without the marker it re-enters this whole outage window — stop,
  # dump, and another drop-and-restore of factions_live — every 2 minutes.
  mark_failed

  if [ "$DRY_RUN" = "1" ] || health_ok "$since"; then
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

# ⚠️ Capture the currently-running images before checkout moves the tree to
# $TAG, so rollback() can identify what "back to $CURRENT" means.
# ⚠️ BOTH services (Ruling 10): the build below builds web AND ingest-worker, so
# capturing web alone would let a rollback leave the worker on the new image
# against the restored old schema — invisible to every health check here,
# because the worker serves no HTTP.
# sudo -n docker, not bare docker: our unit runs as acab, not root (contrast
# deploy/systemd/clan-wars-backup.service, which has no User= and can use
# bare docker) — see deploy/deploy-web.sh for the house pattern.
PREV_IMAGE_WEB=$(sudo -n docker compose images -q web 2>/dev/null || true)
PREV_IMAGE_WORKER=$(sudo -n docker compose images -q ingest-worker 2>/dev/null || true)

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

# ⚠️ Ruling 17. The bot is NOT containerised — it runs from this tree against
# host node_modules, and nothing else installs them, so a release that adds or
# bumps a dependency would start a bot importing a package that is not there.
# --frozen-lockfile, so a lockfile the release forgot to update fails here
# rather than resolving to something nobody tested. Still in the preflight,
# where a failure costs only a revert with nothing stopped.
if ! run "$PNPM" install --frozen-lockfile; then
  revert_tree || alert "CRITICAL" "pnpm install failed for $TAG AND the revert to $PREV_REF failed; tree or node_modules is still $TAG's with nothing stopped — needs a human"
  alert "BLOCKED" "pnpm install --frozen-lockfile failed for $TAG; reverted to $PREV_REF, nothing stopped"
  exit 1
fi

if ! run sudo -n docker compose build -q web ingest-worker; then
  revert_tree || alert "CRITICAL" "build failed for $TAG AND the revert to $PREV_REF failed; tree or node_modules is still $TAG's with nothing stopped — needs a human"
  alert "BLOCKED" "build failed for $TAG; reverted to $PREV_REF, nothing stopped"
  exit 1
fi

# ⚠️ Timestamped, not keyed on the tag alone. Two attempts at the same tag —
# the ordinary case after a human clears $FAILED_MARKER — would otherwise write
# the SECOND attempt's dump over the first, and the second attempt dumps a
# database the first attempt's migration has already touched. That overwrite
# destroys the only artifact a rollback can restore from.
DUMP="$BACKUPS/predeploy-$TAG-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

# ⚠️ Belt and braces on the same point: refuse rather than overwrite, always,
# whatever the name resolves to. Checked BEFORE stop_all, so this exits with
# nothing stopped.
if [ -e "$DUMP" ]; then
  alert "BLOCKED" "$DUMP already exists; refusing to overwrite a pre-deploy dump"
  exit 1
fi

# ⚠️ Guarded, in the same shape as the dump-failure branch below, and for a
# sharper reason. stop_all returns 1 the moment `systemctl stop clan-wars-bot`
# fails, so a bare call would exit here instantly under set -e: no alert, no
# marker, `docker compose stop` never reached (web and the worker stay UP), and
# the tree left at $TAG. Two minutes later the dirty-tree guard sees a clean
# tree and PREV_REF captures $TAG — so a later rollback would faithfully
# "restore" the release that failed.
if ! stop_all; then
  alert "CRITICAL" "could not stop all writers before the dump for $TAG; NOT deploying"
  # `|| true`: the stop already failed, so some of these are likely running
  # anyway, and a failure to start what is already started must not mask the
  # alert above.
  start_all || true
  mark_failed
  exit 1
fi

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

  # ⚠️ Rotate, and only AFTER the dump above verified — same rule as
  # deploy/backup/backup-factions-live.sh, and for the same reason: rotation
  # that runs regardless of dump success deletes good dumps over successive
  # failing runs. These live on the volume the nightly backups need, and that
  # script only rotates `factions_live-*`, so nothing else would ever prune
  # `predeploy-*`. Never fatal: a failed prune is disk hygiene, not a deploy
  # fault, and must not strand the services this script has already stopped.
  ls -1t "$BACKUPS"/predeploy-*.sql.gz 2>/dev/null | tail -n +$((KEEP_PREDEPLOY + 1)) | xargs -r rm -- \
    || alert "WARN" "could not prune old pre-deploy dumps in $BACKUPS"
else
  printf 'DRY: pg_dump → %s\n' "$DUMP"
fi

# ⚠️ Every failure past this point must reach rollback(), not abort with the
# services stopped and nothing said. rollback() disarms this trap on entry so it
# cannot recurse into itself. It fires inside functions too — see the ⚠️ on
# `set -E` at the top of this file, without which it would fire almost nowhere.
# ⚠️ $LINENO here is the line inside whichever function failed, NOT this call
# site, precisely because the trap is inherited — so the message says "near",
# and the rollback's own reason strings are what actually locate the step.
trap 'rollback "unhandled failure near line $LINENO"' ERR

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

# ⚠️ The bot starts LAST, after the services have passed, and this ordering is
# load-bearing — not tidiness. rollback() restores a dump taken before anything
# started, so every write made between the start and the rollback is DISCARDED.
# In this window that is `web` (writes only on an explicit user action) and
# `ingest-worker` (whose writes are re-ingested from the ADM logs once its
# cursor rewinds): bounded, recoverable damage. The bot is neither — it writes
# every 10 s and `notifyCompleted` DMs BEFORE it marks, so rewinding a mark
# re-sends a DM to a real player, which is the 2026-09-01 incident, automated.
# Starting the bot before the services are proved healthy would put that inside
# the rollback's blast radius for the sake of a few seconds.
start_services

# ⚠️ The gate: state is recorded and the marker cleared ONLY after both checks
# pass, so a bad health result can never land on a cleared marker — the marker
# is what stops a failed deploy re-entering the outage window every 2 minutes.
# On a real failure this goes to rollback(), never to a bare exit — see the ⚠️
# on the ERR trap above.
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY: services_ok (skipped)"
  echo "DRY: start_bot (skipped)"
  echo "DRY: bot_ok (skipped)"
else
  if ! services_ok; then
    # ⚠️ Says what the rollback throws away, because at this call site — unlike
    # the two above — it is not nothing.
    rollback "health check failed after deploying $TAG (discarding up to 90s of web/ingest-worker writes; the bot never started)"
  fi

  # ⚠️ Captured immediately before the start: bot_ok scans the journal from this
  # instant, so an earlier stamp could match the `bot ready as` line of the run
  # stop_all just ended, and a later one could miss this run's.
  BOT_SINCE=$(date '+%Y-%m-%d %H:%M:%S')
  start_bot

  if ! bot_ok "$BOT_SINCE"; then
    rollback "the bot did not come up after deploying $TAG (discarding up to 3min of web/ingest-worker writes)"
  fi

  # ⚠️ Disarm before the bookkeeping. Past this point the deploy is verified
  # healthy and the bot is LIVE; a failure to write $STATE is worth an alert and
  # a retry, never a rollback — which would stop everything and drop and restore
  # factions_live out from under a working release, discarding every write since
  # the services came up, the bot's included. That is precisely what starting the
  # bot after the health check exists to prevent, and leaving this path armed is
  # how that gets undone. $STATE and $FAILED_MARKER share /var/lib/clan-wars,
  # created as root while this unit runs as acab, so this is the same
  # "reachable, not hypothetical" permission failure the dump branches call out.
  trap - ERR

  state_write "$TAG" || alert "CRITICAL" "deploy of $TAG is healthy but $STATE could not be written; it will redeploy in 2 minutes"
  # ⚠️ Cleared unconditionally now, because the release above is verified
  # healthy: a marker left behind from an earlier failed attempt at this same
  # tag would silently BLOCK its next real deploy forever. Non-fatal for the same
  # reason as the write above — bookkeeping never decides whether production runs.
  run rm -f "$FAILED_MARKER" || alert "CRITICAL" "deploy of $TAG is healthy but $FAILED_MARKER could not be cleared; the next deploy of this tag will be BLOCKED until it is removed"
  alert "DEPLOYED" "$TAG is live (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"
fi
