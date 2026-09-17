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
# ⚠️ The two "we have already alerted about this" sidecars. Both BLOCKED
# conditions are refusals that only a human clears, so without these the timer
# repeats the same alert every 2 minutes — 720 a day — and the CRITICALs this
# design relies on someone reading get buried under them.
: "${NOTIFIED_MARKER:=${FAILED_MARKER}.notified}"
: "${DIRTY_NOTIFIED:=${STATE}.dirty-notified}"
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
# ⚠️ `|| return 1` on both lines, for the reason spelled out in stop_all below:
# without it this function's status is its LAST command's only, so a failed
# mkdir followed by a redirect that failed for the same reason could still be
# read as success by the `state_write … || alert` call site — and losing the
# state file silently is what redeploys the same tag every 2 minutes forever.
state_write() {
  run mkdir -p "$(dirname "$STATE")" || return 1
  run sh -c "printf '%s\n' '$1' > '$STATE'" || return 1
}

# ⚠️ Never called on a no-op. At a 2-minute interval that is 720 messages a
# day, and an alert channel nobody reads is not an alert channel.
alert() {
  local level="$1" text="$2"
  printf '[%s] %s\n' "$level" "$text"
  [ -n "${DEPLOY_WEBHOOK_URL:-}" ] || return 0
  # ⚠️ Escape backslashes then double quotes before this goes into the JSON
  # body. Reason strings interpolate $RETAG_ERROR and $DUMP, and a single `"`
  # or `\` in either produces invalid JSON: Discord answers 400, `|| true`
  # swallows it, and the alert nobody sees is the one saying production needs a
  # human. Backslashes first — doing it the other way round would re-escape the
  # backslashes this step introduces.
  local json="${text//\\/\\\\}"
  json="${json//\"/\\\"}"
  run curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"content": "**%s** %s"}' "$level" "$json")" \
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

# Point both compose image tags back at the images captured in the preflight.
# Shared by rollback() and restore_previous_release() so the two cannot drift —
# they differ in what they DO about a failure, not in what counts as one.
# Returns 1 and leaves the reason in $RETAG_ERROR.
#
# ⚠️ The tag to restore is whatever compose calls each service's image — derived
# from the compose project name, NOT necessarily `clan-wars-web:latest`, so it is
# asked for rather than assumed; a wrong tag would silently leave the NEW image
# running while everything reported success. Resolved after the tree is back, so
# the names come from the old tree's compose file.
# ⚠️ BOTH services (Ruling 10): restoring web alone leaves ingest-worker on the
# NEW image against the OLD schema, and no check here can see it — the worker
# serves no HTTP.
# ⚠️ An empty value is never skipped. $PREV_IMAGE_* is empty when no container
# existed at capture time — exactly the state a previous failed deploy leaves —
# and the compose lookup is empty when `sudo -n` is refused. Either way we cannot
# name what we are restoring to, and continuing would leave the NEW image in
# place under a message saying otherwise.
# ⚠️ `docker compose config --images` runs even under --dry-run (read-only, but
# privileged), so a dry run is not runnable unprivileged — same precedent as the
# `compose images -q` capture in the flow below.
retag_previous_images() {
  local svc prev target
  for svc in web ingest-worker; do
    case "$svc" in
      web) prev="${PREV_IMAGE_WEB:-}" ;;
      *)   prev="${PREV_IMAGE_WORKER:-}" ;;
    esac
    if [ -z "$prev" ]; then
      RETAG_ERROR="no previous image was captured for $svc; the NEW image would keep running"
      return 1
    fi
    target=$(sudo -n docker compose config --images "$svc" 2>/dev/null | head -1 || true)
    if [ -z "$target" ]; then
      RETAG_ERROR="could not resolve the compose image name for $svc; the NEW image would keep running"
      return 1
    fi
    if ! run sudo -n docker tag "$prev" "$target"; then
      RETAG_ERROR="could not retag $target to $prev; the NEW $svc image would start"
      return 1
    fi
  done
  return 0
}

# Ruling 19. Put production back on the release it was running, WITHOUT touching
# the database. For the pre-deploy aborts: by the time they run, the build has
# already produced and tagged the NEW images and the tree is at $TAG, so a bare
# start_all would recreate the containers on new code against the old schema —
# the 2026-09-02 failure, on paths whose own alert says nothing was deployed.
#
# ⚠️ NOT rollback(): no migration has run, so there is no schema to undo, and on
# the dump-failure path there may be no usable dump at all. Restoring the
# database here would destroy writes for no reason.
# ⚠️ Alerts and CONTINUES rather than calling rollback_abort. Every caller is
# already on its way to `exit 1` with an alert of its own; a second abort path
# would only obscure the first. Nothing here fails silently, which is the
# requirement — not that it fails hard.
#
# ⚠️ But CONTINUING IS NOT STARTING. No start runs whose precondition failed:
# the bot runs from the tree, so a failed revert_tree means it would launch
# $TAG's code against the un-migrated OLD schema; the two containers run from
# the image tags, so a failed retag means they would come up on NEW images. Both
# are the 2026-09-02 new-code/old-schema failure, and both are LOUD — CRITICAL
# fires either way. Loudness is not enough: a half-restored host with services
# down is a visible outage a human recovers from, while a half-restored host
# serving a split version looks fine and is silently wrong. So when a
# precondition fails we deliberately leave that half down, and say so.
restore_previous_release() {
  local tree_ok=1 images_ok=1

  if ! revert_tree; then
    tree_ok=0
    alert "CRITICAL" "could not restore the tree to ${PREV_REF:-HEAD} after aborting the deploy of $TAG; live nginx/systemd config is still $TAG's"
  fi

  if ! retag_previous_images; then
    images_ok=0
    alert "CRITICAL" "aborting the deploy of $TAG: ${RETAG_ERROR:-retag failed}"
  fi

  # The containers' CODE depends on the image tags only, so a wrong tree does
  # not stop the code they run being the previous release's.
  # ⚠️ Their CONFIGURATION does not: `docker compose up -d` reads the tree's
  # docker-compose.yml for environment, ports, volumes, `command` and
  # depends_on, so starting them with the tree still at $TAG gives them the old
  # image under the new release's compose settings. That is a narrower hazard
  # than new code on the old schema — which is why we still start them — but it
  # is not nothing, and the CRITICAL above is what says a human must look.
  if [ "$images_ok" = "1" ]; then
    start_services || alert "CRITICAL" "could not restart web/ingest-worker after aborting the deploy of $TAG"
  else
    # ⚠️ "not started", not "stopped": on the aborts that never reached stop_all
    # these containers are still up on the OLD code they were already running,
    # and that is fine — the hazard is `up -d` RECREATING them on a new tag.
    alert "CRITICAL" "deliberately NOT starting web/ingest-worker after aborting the deploy of $TAG: their image tags could not be restored, so starting them would recreate the containers on NEW code against the OLD schema. If they are down, they stay down until a human fixes the tags."
  fi

  # The bot is not containerised: it runs from this tree, so the tree is its
  # whole precondition.
  if [ "$tree_ok" = "1" ]; then
    start_bot || alert "CRITICAL" "could not restart clan-wars-bot after aborting the deploy of $TAG"
  else
    # ⚠️ Same distinction: an already-running bot is untouched — it loaded its
    # code at start and is still on the old release. What must not happen is
    # STARTING one from a tree that is still at $TAG.
    alert "CRITICAL" "deliberately NOT starting clan-wars-bot after aborting the deploy of $TAG: the tree is still at $TAG, so it would run NEW code against the OLD schema. If it is down, it stays down until a human restores ${PREV_REF:-HEAD}."
  fi
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
# ⚠️ `timeout 10` on every docker probe, because the deadline above is tested
# only at the TOP of the loop. A wedged docker daemon or a container in
# uninterruptible sleep makes `docker compose ps`/`docker exec` block forever;
# the loop then never re-tests the deadline, and the unit is Type=oneshot,
# where TimeoutStartSec defaults to infinity — so the deploy hangs indefinitely
# with the bot stopped and not one alert sent. curl is already bounded by its
# own --max-time.
# ⚠️ Deliberately UNLIKE the restore in rollback(), which must never be given a
# timeout: killing a restore leaves a half-populated database that passes every
# check here. A probe is different — nothing is mid-write, so killing one costs
# an iteration.
services_ok() {
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if timeout 10 sudo -n docker compose ps postgres --format '{{.Health}}' 2>/dev/null | grep -q healthy \
      && curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:3020/ \
      && timeout 10 sudo -n docker exec "$CONTAINER" psql -U factions -d factions_live -X -tAc 'select 1' >/dev/null 2>&1
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
# `bot ready as <discord user tag>` is logged once, unconditionally, from the
# `clientReady` handler in apps/bot/src/discord.ts, AFTER the Discord login: the
# first moment the bot genuinely exists. ⚠️ The line carries the bot's DISCORD
# user tag, not the release tag — so only the fixed prefix is matched here, and
# an operator reading the journal should not expect to see $TAG in it.
bot_ok() {
  local since="$1" deadline=$((SECONDS + 90))

  # ⚠️ Fail CLOSED is wrong here. If acab cannot read this unit's journal, the
  # grep below never matches and every healthy deploy rolls back — dropping and
  # restoring factions_live each time. So probe the journal once first, and fall
  # back if it is unreadable.
  # ⚠️ Non-empty OUTPUT, not exit status. `journalctl -u <system unit>` run by a
  # user outside adm/systemd-journal does NOT fail: it silently opens only that
  # user's journal, matches nothing, and exits 0. An exit-status probe therefore
  # passes exactly when it should have failed — the fallback never runs, the
  # grep loop below spins out its 90 s, bot_ok returns 1, and a HEALTHY deploy
  # rolls back, dropping and restoring factions_live. Emptiness is the only
  # signal that distinguishes the two.
  if [ -z "$(timeout 10 journalctl -u clan-wars-bot -n 1 --no-pager -q 2>/dev/null)" ]; then
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
    # timeout 10 for the same reason as services_ok's probes: the deadline is
    # tested only at the top of this loop, so a journalctl that blocks would
    # hang the deploy forever with the unit's infinite TimeoutStartSec.
    if timeout 10 journalctl -u clan-wars-bot --since "$since" 2>/dev/null | grep -q 'bot ready as'; then
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
  # A fresh failure must be able to alert again, whatever we said about an
  # earlier one — the sidecar suppresses repeats of a refusal, never the first
  # report of a new failure.
  run rm -f "$NOTIFIED_MARKER" || true
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
  # $CURRENT is empty on a first run, and a tag is in any case not evidence of
  # what this tree was actually checked out at. (It is NOT about pruning —
  # `git fetch --tags --prune` does not prune tags; that needs --prune-tags. And
  # it is NOT about detachment: $PREV_REF is a bare SHA, so HEAD ends up
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

  # ⚠️ Shared with the pre-deploy aborts (retag_previous_images, above) so the
  # two paths cannot disagree about what "the previous image" means. Here a
  # failure is fatal: a rollback that cannot name what it is rolling back to is
  # not a rollback, and continuing would start the NEW image while alerting
  # success. Abort instead — a stopped service is a visible outage.
  if ! retag_previous_images; then
    rollback_abort "$reason (${RETAG_ERROR:-retag failed})"
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
  # ⚠️ Alert ONCE per condition, not once per poll. Neither BLOCKED condition
  # self-clears — only a human clears them — so alerting on every tick is 720
  # Discord messages a day, which buries the CRITICALs this whole design
  # depends on somebody actually reading. The sidecar records what we have
  # already said; the FIRST alert still fires immediately, because a refusal
  # nobody hears about is how a release sits undeployed for a week.
  # ⚠️ Keyed on the tag, so a marker for a DIFFERENT tag alerts afresh, and
  # cleared wherever $FAILED_MARKER is (mark_failed, the dump-failure paths and
  # the success path) so the next genuine failure is never silent.
  if [ "$(cat "$NOTIFIED_MARKER" 2>/dev/null)" != "$TAG" ]; then
    alert "BLOCKED" "previous deploy of $TAG failed and left $FAILED_MARKER; refusing to retry automatically until it is removed (this is the only alert for it; the refusal repeats silently every 2 minutes)"
    run sh -c "printf '%s\n' '$TAG' > '$NOTIFIED_MARKER'" \
      || alert "WARN" "could not write $NOTIFIED_MARKER; this BLOCKED alert will repeat every 2 minutes"
  fi
  exit 1
fi

# ⚠️ An edit on the box is either an emergency hotfix or a mistake. Both
# deserve a human: `git checkout` would discard either one silently.
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  # ⚠️ Same once-per-condition rule, keyed on a checksum of the porcelain
  # output rather than on the tag: the dirt is what has to change before this
  # is news again, and keying on the tag would re-alert on every unrelated
  # release while a stale edit sits on the box. A changed edit re-alerts, which
  # is right — it is a different fact about the host.
  DIRTY_KEY=$(printf '%s' "$DIRTY" | cksum)
  if [ "$(cat "$DIRTY_NOTIFIED" 2>/dev/null)" != "$DIRTY_KEY" ]; then
    alert "BLOCKED" "working tree at $REPO is dirty; refusing to deploy $TAG (this is the only alert until the tree changes; the refusal repeats silently every 2 minutes)"
    run sh -c "printf '%s\n' '$DIRTY_KEY' > '$DIRTY_NOTIFIED'" \
      || alert "WARN" "could not write $DIRTY_NOTIFIED; this BLOCKED alert will repeat every 2 minutes"
  fi
  exit 1
fi

# Past both refusals: the tree is clean and this tag is not blocked, so any
# earlier "we already said so" record is stale.
run rm -f "$DIRTY_NOTIFIED" || true

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

# ⚠️ Pin each captured image under a NAME immediately, and roll back to the
# name rather than the id. The `docker compose build` below retags the compose
# image name onto the newly built image, which leaves the image captured above
# DANGLING — reachable only by the bare id in these variables. Any
# `docker image prune` on this host deletes dangling images, and this host also
# serves three unrelated production sites, so that command is run here for
# reasons that have nothing to do with clan-wars. The rollback target would
# then evaporate silently between the build and the rollback that needed it,
# and retag_previous_images would fail with "no such image" at the worst
# possible moment. A named tag is not dangling and cannot be pruned that way.
# ⚠️ Non-fatal: if the pin fails we keep the bare id, which is still a correct
# rollback target for as long as nothing prunes. Refusing to deploy because a
# protective retag failed would trade a small risk for a certain outage.
ROLLBACK_IMAGE_WEB=clan-wars-web:rollback
ROLLBACK_IMAGE_WORKER=clan-wars-ingest-worker:rollback
if [ -n "$PREV_IMAGE_WEB" ]; then
  if run sudo -n docker tag "$PREV_IMAGE_WEB" "$ROLLBACK_IMAGE_WEB"; then
    PREV_IMAGE_WEB="$ROLLBACK_IMAGE_WEB"
  else
    alert "WARN" "could not pin the current web image as $ROLLBACK_IMAGE_WEB; the rollback target is an unpinned image id that a docker prune would destroy"
  fi
fi
if [ -n "$PREV_IMAGE_WORKER" ]; then
  if run sudo -n docker tag "$PREV_IMAGE_WORKER" "$ROLLBACK_IMAGE_WORKER"; then
    PREV_IMAGE_WORKER="$ROLLBACK_IMAGE_WORKER"
  else
    alert "WARN" "could not pin the current ingest-worker image as $ROLLBACK_IMAGE_WORKER; the rollback target is an unpinned image id that a docker prune would destroy"
  fi
fi

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
# empty on a first run, and a tag is in any case not evidence of what this tree
# was checked out at. Checking out a tag would also silently leave it detached — which
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
  # ⚠️ The one abort that is a bare revert_tree, deliberately: it sits BEFORE the
  # build, so no image has been retagged and the running containers are untouched
  # — there is nothing for restore_previous_release to put back, and starting
  # services that were never stopped would be noise.
  revert_tree || alert "CRITICAL" "pnpm install failed for $TAG AND the revert to $PREV_REF failed; tree or node_modules is still $TAG's with nothing stopped — needs a human"
  alert "BLOCKED" "pnpm install --frozen-lockfile failed for $TAG; reverted to $PREV_REF, nothing stopped"
  exit 1
fi

# ⚠️ restore_previous_release, not a bare revert_tree: `build` builds two
# services, so a build that fails on the SECOND has already retagged the first's
# compose image to new code. Nothing has been stopped, so the containers still
# run the old images — until the next `up -d` anywhere silently promotes the new
# one against the old schema (Ruling 19).
if ! run sudo -n docker compose build -q web ingest-worker; then
  restore_previous_release
  alert "BLOCKED" "build failed for $TAG; restored $PREV_REF, nothing stopped"
  exit 1
fi

# ⚠️ Timestamped, not keyed on the tag alone. Two attempts at the same tag —
# the ordinary case after a human clears $FAILED_MARKER — would otherwise write
# the SECOND attempt's dump over the first, and the second attempt dumps a
# database the first attempt's migration has already touched. That overwrite
# destroys the only artifact a rollback can restore from.
DUMP="$BACKUPS/predeploy-$TAG-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

# ⚠️ Belt and braces on the same point: refuse rather than overwrite, always,
# whatever the name resolves to. Checked BEFORE stop_all, so nothing is stopped
# here — but it is AFTER the build, so the tree is at $TAG and both compose image
# tags already point at new code. It therefore restores like the other aborts
# (Ruling 19): "nothing stopped" is not the same as "nothing changed".
if [ -e "$DUMP" ]; then
  restore_previous_release
  alert "BLOCKED" "$DUMP already exists; refusing to overwrite a pre-deploy dump; restored $PREV_REF"
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
  # ⚠️ Ruling 19: restore, not a bare start_all. The build above already retagged
  # both compose images to new code and the tree is at $TAG, so starting here
  # would recreate the containers on new code against the old schema — on a path
  # whose own alert says nothing was deployed. Every step inside alerts on
  # failure and continues; nothing here is silent.
  restore_previous_release
  mark_failed
  exit 1
fi

# ⚠️ THE point of no return, recorded the moment it is crossed — this marker
# write is the important one, and the later ones on the failure paths are only
# belt and braces. Nothing in this script handles SIGTERM, SIGKILL, the OOM
# killer or a power cut, so a host that reboots anywhere inside the window
# below leaves: services stopped, possibly a migrated schema, the tree at $TAG
# — and, without this line, NO marker. The timer then redeploys the same tag in
# 2 minutes, takes its "pre-deploy" dump of an ALREADY-MIGRATED database, and a
# rollback from that dump restores the new schema under the old code. That is
# the 2026-09-02 new-code/old-schema incident this entire design exists to
# avoid, arrived at automatically and silently.
# The success path clears the marker unconditionally, so writing it here costs
# a healthy deploy nothing.
mark_failed

# Same idiom as deploy/backup/backup-factions-live.sh: dump inside the
# container, write .part, rename only on success.
# ⚠️ Guarded like the dump below it, and for the same reason. This is the one
# mutation inside the outage window that is not: under `set -e` with the ERR
# trap not yet armed, a failed mkdir (a full or unwritable /var/backups, or the
# directory owned by root while this unit runs as acab) would exit IMMEDIATELY
# — all three writers stopped, no alert, nothing restored — and the timer would
# repeat it every 2 minutes forever.
if ! run mkdir -p "$BACKUPS"; then
  alert "CRITICAL" "could not create $BACKUPS for $TAG's pre-deploy dump; restoring $PREV_REF and restarting services, NOT deploying"
  restore_previous_release
  mark_failed
  exit 1
fi
if [ "$DRY_RUN" = "0" ]; then
  # ⚠️ Not left to bare `set -e`: a pg_dump error, a full disk, or a failed
  # mv must restart services and alert, not exit instantly with production
  # down and nothing said.
  if ! { sudo -n docker exec "$CONTAINER" pg_dump -U factions -d factions_live --no-owner \
      | gzip -9 > "$DUMP.part"; } || ! mv "$DUMP.part" "$DUMP"; then
    alert "CRITICAL" "pre-deploy dump for $TAG failed to complete; restoring $PREV_REF and restarting services, NOT deploying"
    # ⚠️ Ruling 19: the tree is at $TAG and both compose images are already
    # retagged to new code, so a bare start_all would bring production up on new
    # code against the old schema. The database is deliberately NOT touched —
    # no migration has run, and on this path there may be no usable dump at all.
    restore_previous_release
    # ⚠️ After the restore, and never fatal: this is bookkeeping, and a failure
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
    alert "CRITICAL" "pre-deploy dump for $TAG failed verification; restoring $PREV_REF and restarting services, NOT deploying"
    # ⚠️ Same as above (Ruling 19): restore the tree and both image tags before
    # starting, or production comes up on new code against the old schema.
    restore_previous_release
    # ⚠️ Never fatal, and after the restore — bookkeeping must not be able to
    # strand the outage.
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
  # ⚠️ Removed with the marker, always: a sidecar outliving the marker it
  # describes would suppress the FIRST alert of the next real failure.
  run rm -f "$NOTIFIED_MARKER" || true
  alert "DEPLOYED" "$TAG is live (host-config=$HOST_CONFIG migrations=$MIGRATIONS)"
fi
