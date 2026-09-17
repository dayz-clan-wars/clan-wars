# Automatic deployment on release

2026-09-16. Design: `docs/superpowers/specs/2026-09-16-auto-deploy-design.md`
(⚠️ amended twice since it was written — read those amendments; the shipped
script's start order and its rollback's losslessness both differ from the
original text). Script: `deploy/deploy-release.sh`. Units:
`deploy/systemd/clan-wars-deploy.{service,timer}`. Install steps for the
symlinks also live in `deploy/README.md`; this file is the operator's runbook
— read both.

## What this reverses

Until today, `CLAUDE.md` said nothing applies migrations automatically, and
said so because of a real incident: on 2026-09-02 the bot looped on
`dormancy tick failed … column "dormant_since" does not exist` until `0015`
was applied by hand. That is now false. `clan-wars-deploy.timer` runs
`deploy/deploy-release.sh` every two minutes; on a new tag it checks out the
tag and builds the images first, then stops all three writers, dumps
`factions_live`, and only then runs `pnpm db:migrate --apply --production` —
rolling code, image, host config and schema all back together if anything
from that point fails. What makes this safe rather than merely automated is
the **stop-before-dump ordering**: the dump is taken after every writer that
touches `factions_live` is stopped, which is what turns "restore the
database" from a data-loss event into an exact undo at most of the failure
points (see the design doc's §4 amendment for the two call sites where that
is no longer exactly true, and why).

## 0. Prerequisite: `acab`'s passwordless sudo

**Verify this before anything else.** The script runs as `acab`
(`deploy/systemd/clan-wars-deploy.service`) and calls `sudo -n` — non-interactive,
so a missing sudoers entry doesn't prompt, it fails the call outright — for
every privileged step: `docker`, `docker compose`, `systemctl`, and
`nginx -t`/`reload`. Without every one of these granted, the script dies at
its first privileged call, mid-preflight or mid-outage depending on which
command it hits first, and the failure mode differs by exactly where it
happens.

Check the sudoers entry names these command groups (or `ALL`) with `NOPASSWD`,
then confirm each one actually runs non-interactively as `acab`:

    sudo -l -U acab

    sudo -u acab sudo -n docker compose ps >/dev/null && echo OK
    sudo -u acab sudo -n systemctl status clan-wars-bot >/dev/null && echo OK
    sudo -u acab sudo -n nginx -t && echo OK

Each should print `OK` (or nginx's own success message) with no password
prompt. A prompt means the entry is missing or wrong — fix it before going any
further; every later step assumes this already works.

### The other four prerequisites

Each of these is something the script cannot check for itself, and each maps to
a way it fails quietly rather than loudly.

**1. `acab` can read the bot's journal.** The bot health gate greps
`journalctl -u clan-wars-bot` for `bot ready as`:

    sudo -u acab journalctl -u clan-wars-bot -n 1

⚠️ This must print a **real log line**. `-- No entries --`, or empty output,
means `acab` is outside `adm`/`systemd-journal` and is being shown only its own
user journal — `journalctl` does **not** fail in that case; it matches nothing
and exits 0. The script detects this by testing for non-empty output rather
than exit status, and falls back to a weaker late `is-active` check with a
`WARN`. This command is the more certain answer, and adding `acab` to
`systemd-journal` now is better than deploying on the fallback: before that
detection was corrected, this condition rolled back every **healthy** deploy —
a real drop-and-restore of `factions_live` each time.

**2. `/var/backups/clan-wars` exists and is writable by `acab`.**

    sudo -u acab test -w /var/backups/clan-wars && echo OK

The nightly backup unit runs as **root** and creates this directory root-owned;
the deployer runs as `acab`. `deploy/README.md`'s install steps have the
`install -d -o acab -g acab` that fixes it. A failure here lands inside the
outage window — guarded, with a `CRITICAL` and a restore, but an outage.

**3. `acab`'s git can reach `origin`.**

    sudo -u acab git -C /opt/clan-wars fetch --tags --prune origin

Nothing anywhere checks this, and `git fetch` is inside `run()`, so `--dry-run`
prints it rather than proving it. Without a credential or key for the remote
the script fetches nothing and deploys against whatever tags happen to be local
already — including never seeing a new release at all.

**4. `NODE_ENV` is absent from `/opt/clan-wars/.env`.**

    grep '^NODE_ENV' /opt/clan-wars/.env && echo "REMOVE THIS" || echo OK

The script does `set -a; . ./.env; set +a`, which **exports** everything in
that file to every child process. `NODE_ENV=production` makes
`pnpm install --frozen-lockfile` prune devDependencies — including `tsx`, which
`pnpm db:migrate`, the bot's `start` script and the rollback's own
`pnpm install` all need. The first failure lands mid-outage, and the rollback's
install is pruned by the same variable.

## 1. Install

**The state directory must be owned by `acab`, and this order matters.**

    sudo install -d -o acab -g acab /var/lib/clan-wars

⚠️ If this directory is root-owned instead, the script's two writes under it —
the deployed-tag state file on every success, and the failure marker on every
failure — both fail silently from the script's own point of view (it alerts,
but does not stop). The state-file failure is the dangerous one: it happens
**after a deploy that already succeeded** — services are up, the migration
applied, the bot is live — so the tag is simply never recorded. Two minutes
later the timer polls again, sees the same "new" tag against the stale state
file, and redeploys it: a full stop/dump/migrate/start outage, repeated every
two minutes, forever, with every deploy individually reporting success. Fix
the ownership, don't just watch it happen — a future `sudo mkdir
/var/lib/clan-wars` (recreating the directory as root) reintroduces this
exact loop.

**Seed the state file with the tag currently live**, written as `acab` so it
matches the directory:

    echo v1.15.0 | sudo -u acab tee /var/lib/clan-wars/deployed-tag

(Substitute the real tag. Skipping this makes the very first run "deploy" the
newest tag over whatever is actually live already, with no state to compare
against.)

**Add the webhook**, in `/opt/clan-wars/.env`:

    DEPLOY_WEBHOOK_URL=<discord webhook url>

Create it in the ops channel: Channel Settings → Integrations → Webhooks. Never
commit it — `.env` is gitignored and always has been. This is deliberately
independent of the bot: the bot is stopped for most of a deploy and may be the
thing that failed, so it cannot also be the channel that reports the failure.

**Symlink and enable the units:**

    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.service \
      /etc/systemd/system/clan-wars-deploy.service
    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-deploy.timer \
      /etc/systemd/system/clan-wars-deploy.timer
    sudo systemctl daemon-reload

⚠️ **`daemon-reload` only here — do not `enable --now` the timer yet.** Step 2
(the dry run) has to pass first, and the timer must not be armed until someone
is ready to run step 4's rehearsals immediately and watch them: they are what
proves the rollback works, and until they have run, an unrehearsed
`rollback()` — a real drop-and-restore of `factions_live` — is what the first
failing release triggers. `deploy/README.md`'s install steps say the same, and
deliberately stop at `daemon-reload` for this reason.

## 2. The dry run — required, and it cannot happen anywhere but here

    cd /opt/clan-wars && ./deploy/deploy-release.sh --dry-run

Every mutating command in the script goes through a `run()` wrapper that,
under `--dry-run`, prints `DRY: <command>` instead of executing it — that
printed transcript is the reviewable artifact. Read it end to end before
enabling anything.

⚠️ **This genuinely cannot be exercised end to end anywhere but this host,
first.** It is not merely "the safe way to check" — a developer machine can't
complete the run at all: no `flock` contention to model the way the real lock
file does, no `/home/acab/.local/bin/pnpm` at that path, and the dump
verification uses `stat -c %s`, which is GNU-only (macOS's `stat` takes
different flags and errors out). So the dry run on the production host, by
hand, is the first point in this project's life the script has ever run start
to finish at all. Treat it as exactly that, not as a formality on the way to
enabling the timer.

## 3. Enable the timer — with step 4 starting immediately afterwards

⚠️ Step 4's rehearsals need the timer running (they tag a release and watch the
deployer pick it up), which is why this step comes before them. That makes this
the moment the machinery becomes live: from here until the rehearsals are done,
any tag reaching `main` deploys itself, and a failing one rolls back for real.
Do not enable the timer and walk away.

    sudo systemctl enable --now clan-wars-deploy.timer
    systemctl list-timers clan-wars-deploy
    journalctl -u clan-wars-deploy -n 20

Expect the timer listed with a next-elapse time, and (assuming step 1's seed
matches the currently-deployed tag) a run that exits 0 with nothing printed —
the no-op path, silent by design (§2 of the spec: an alert on every two-minute
no-op is 720 messages a day, and a channel nobody reads is not an alert
channel).

## 4. Rehearsal — a gate, not a suggestion

⚠️ **Until all three of these have been run, the rollback is a design, not a
capability, and must not be described as one** (spec §8). This is not a
formality to skip under time pressure — it is the only way anyone will know,
before it matters, whether `rollback()` actually restores `factions_live`
correctly on this host.

**Rehearsal 1 — no-op release.** Tag a commit that changes nothing:

    git tag v1.9.1 && git push origin v1.9.1

Watch `journalctl -u clan-wars-deploy -f`. Expect the full path to run —
checkout, build, stop, dump, migrate (a no-op), reload nginx, start
`web`/`ingest-worker`, health check, start the bot, its `bot ready as …`
line, state write — a `DEPLOYED` webhook, and roughly 1–3 minutes of
downtime.

⚠️ **Do not read "a release that changes nothing" as "nothing at stake".** The
health gate has never run on this host, and a miscalibration in it — an
unreadable journal, a probe that cannot reach `web`, a bot that takes longer
than 90 s to log in — does not merely fail the deploy: it triggers a genuine
`rollback()`, which **drops and restores `factions_live`** from the dump taken
minutes earlier. A no-op release makes the *code* change nothing. It does not
make the *deploy machinery* a no-op. Do this at a quiet hour, at a terminal,
watching.

⚠️ The journal line is `bot ready as <the bot's Discord user tag>`, from
`apps/bot/src/discord.ts`'s `clientReady` handler — it logs
`client.user?.tag`, the Discord account's name, **not** the release tag. Do not
expect `bot ready as v1.9.1`, and do not treat its absence as a failed deploy
on that basis; the script matches only the fixed `bot ready as` prefix.

**Rehearsal 2 — deliberate rollback, while watching.** ⚠️ Take the row counts
below **before** tagging this rehearsal's release — rehearsal 3 needs the
pre-rollback numbers, and by the time rehearsal 2 has run there is no going
back to "before" without redoing it:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select (select count(*) from factions) as factions,
             (select count(*) from faction_members) as members,
             (select count(*) from identity_links) as links,
             (select count(*) from faction_events) as events"

Then temporarily break the health check so it cannot pass — e.g. point
`services_ok`'s curl at a port nothing serves — tag a release, and watch it
fail on purpose. Confirm, in order:

- the webhook says `ROLLING BACK`, then `ROLLED BACK`;
- `factions_live` is back (the dump-then-restore actually round-tripped);
- `git describe --tags` on the host reports the **previous** tag, not the one
  that failed;
- the site answers again (`curl -fsS http://127.0.0.1:3020/`);
- the bot is running the previous release.

Then revert the sabotage and confirm a normal deploy still works. Do this at a
quiet hour, at a terminal, with `/var/backups/clan-wars/` in view so you can
watch the dump appear.

**Rehearsal 3 — prove the restore actually round-tripped.** ⚠️ Rehearsal 2's
checks — the site answers, the bot is up, `select 1` succeeds — are **all
produced by a half-restored database too**. `psql` reading a dump from stdin
exits 0 even when individual `COPY` blocks fail, which is why the restore runs
under `-v ON_ERROR_STOP=1`; this rehearsal is the only check that confirms that
guard works here, on this host, against a real dump. Row counts, not liveness.

Run the identical query from rehearsal 2's opening step again, now that the
rollback has completed, and compare against the counts taken there. These
four tables are the ones `deploy/README.md` names as unrecoverable by any other
means — `events` can be re-ingested from the ADM logs, these cannot — so they
are what a restore has to get exactly right.

⚠️ Expect **equal** counts, not "close". `web` and `ingest-worker` are up for
up to 90 s before the health check fails, so a difference is possible in
principle; it is not possible in any of these four tables without a player
having founded, joined, linked or triggered a feed row in that window, so treat
any difference as a failed rehearsal and investigate rather than explain it
away. For extra certainty, `pg_dump` the restored database and diff its
schema-only output against the pre-deploy dump's.

## Deploying by hand, if the timer is off

The script takes no arguments beyond `--dry-run`; it always targets the
newest semver tag reachable from `origin/main` that isn't already the current
state. Running it manually is identical to letting the timer fire once:

    cd /opt/clan-wars && sudo -u acab ./deploy/deploy-release.sh

Everything downstream — preflight, checkout, build, stop, dump, migrate,
health check, bot start — is the same path either way; the timer is only
what schedules it.

## Disabling it in a hurry

    sudo systemctl disable --now clan-wars-deploy.timer

This stops future polls; it does **not** touch a deploy already in progress
or revert anything a completed deploy already did. Nothing else needs to
change — the bot, web and ingest-worker keep running whatever release was
last deployed, exactly as before the timer existed. Deploys go back to the
manual `pnpm db:migrate` / `docker compose build && up -d` path documented
elsewhere in `CLAUDE.md` and `docs/deploy/2026-09-14-db-migrate.md`.

## Where pre-deploy dumps land

    /var/backups/clan-wars/predeploy-<tag>-<UTC timestamp>.sql.gz

Timestamped per attempt, not keyed on the tag alone — a second attempt at the
same tag (the ordinary case right after a human clears a `FAILED` marker, see
below) dumps a database the first attempt's migration has already touched, so
overwriting the first dump would destroy the one artifact a rollback from
*that* attempt could have restored from. These share the volume the nightly
`clan-wars-backup.timer` dumps use (`deploy/backup/backup-factions-live.sh`),
which only ever rotates its own `factions_live-*` files, so nothing else
prunes `predeploy-*` — the script does that itself, keeping the **newest 14**,
and only after a dump has passed its own integrity check (so a run of failing
dumps can never prune a good one out from under a future rollback).

## After a `CRITICAL` alert

⚠️ **`CRITICAL` is not one situation — `deploy-release.sh` has three
structurally different call sites for it, and they call for opposite actions.**
Applying the wrong recovery is worse than the failure that paged you: acting
on a healthy, live system as though the database needs restoring is a
self-inflicted outage, with data loss, on top of nothing having actually been
wrong. **Read the alert's own wording before doing anything** — it tells you
which class you're in; do not assume from the word `CRITICAL` alone.

### Class 1 — the rollback itself failed (`rollback_abort()`)

**Recognize it by:** the text contains "`ROLLBACK FAILED after:`" or "`could
not stop services during a failed rollback`".

This is the only class where "the services are stopped and stay stopped, and
the alert names a dump" is true. A migration **did** run before this fired, so
`factions_live` genuinely may need hand recovery, and the alert carries
`Dump: /var/backups/clan-wars/predeploy-<tag>-<timestamp>.sql.gz` (or
`Dump: none` if it never got that far).

Recovery:

1. Establish `factions_live`'s actual state before touching anything — it may
   already be correctly restored, mid-restore, or untouched, depending on
   which step inside the rollback failed. `deploy/README.md`'s "Restoring"
   section has the scratch-database comparison sequence; use it here rather
   than guessing.
2. If a restore from the named dump is still needed, run it by hand — the
   same drop/recreate/`psql -v ON_ERROR_STOP=1` sequence is in
   `deploy/deploy-release.sh`'s `rollback()` function; read it rather than
   retype it from memory.
3. Once the database, tree and images agree with each other, start the
   services by hand, in the order the script itself uses and for the same
   reason — `web`/`ingest-worker` first, confirm they're healthy, **the bot
   last**: `notifyCompleted` DMs a player before it marks the DM sent, so
   starting the bot against a database state it has already ticked past
   reproduces the 2026-09-01 duplicate-DM incident.

       sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
       sudo -n docker compose up -d web ingest-worker
       # confirm: docker compose ps postgres, curl -fsS http://127.0.0.1:3020/
       sudo systemctl start clan-wars-bot
       journalctl -u clan-wars-bot -n 50 --no-pager   # look for "bot ready as"

4. Find and fix the underlying cause before letting the timer near this tag
   again — a `CRITICAL` never fixes itself.

### Class 2 — a pre-migration abort's own recovery failed (`restore_previous_release()` / a bare `revert_tree`)

**Recognize it by:** the text contains any of these literal substrings —
"`aborting the deploy of`" (**six** call sites in `restore_previous_release()`:
a failed tree restore, a failed retag, both "deliberately NOT starting …"
alerts, and — the two that are easy to miss because they name no service in
the phrase — "`could not restart web/ingest-worker after aborting the deploy
of`" and "`could not restart clan-wars-bot after aborting the deploy of`"),
"`could not stop all writers before the dump`",
"`tree or node_modules is still`" (the `pnpm install`-then-`revert_tree`
double failure), "`failed to complete; restoring`" (the pre-deploy dump
itself failed), or "`failed verification; restoring`" (the dump completed
but didn't pass its integrity check). The last two are worth calling out on
their own: a bad dump is one of the likelier things to actually page someone,
and it is exactly the moment an operator most needs to be told the database
was never touched.

**No migration ever ran at these call sites.** `factions_live` was never
touched, and must not be touched now — `restore_previous_release()`'s own
comment in the script says restoring the database here "would destroy writes
for no reason." No dump is referenced in any of these alerts, because none is
relevant: there is nothing to restore from, only host state (tree, dependencies,
image tags, config) to put back.

What actually happened is a **half-restored host, not a down one**: some
pieces may already be back on the previous release, and others are
*deliberately* left down because the one thing that would make starting them
safe — the tree checkout, or an image retag — itself failed. The alert names
exactly which half refused, e.g. "deliberately NOT starting clan-wars-bot …
the tree is still at $TAG" or "could not restore the tree to $PREV_REF".

Recovery is to fix the *specific* piece the alert names — check out
`$PREV_REF` by hand, retag the image, rerun `pnpm install --frozen-lockfile`
— and then start only the service(s) that were withheld, exactly as
`restore_previous_release()` would have. Never touch the database for this
class.

⚠️ **The two "could not restart …" alerts are not that case.** There the
precondition was fine and the start was *attempted and failed* — nothing was
withheld, so "start what was withheld" is the wrong instruction and the service
is simply **down**. Read the rest of the alert stream first: if any other Class
2 alert is present, fix that piece first, because the failed start may be its
consequence. Then start the named service by hand and read its own journal
(`journalctl -u clan-wars-bot -n 50 --no-pager`, or
`sudo -n docker compose logs --tail 50 web ingest-worker`) for why it refused —
the deploy script only knows that `systemctl start` / `up -d` returned
non-zero, never why. Order still matters: `web`/`ingest-worker` first, the bot
last, for the reason in Class 1 step 3.

### Class 3 — bookkeeping only; the thing it was recording is already fine

**Recognize it by:** the text contains "`is healthy but … could not be
written`", "`is healthy but … could not be cleared`", or
"`this deploy will retry in 2 minutes`".

⚠️ **Whatever this alert is bookkeeping for has already finished correctly —
a healthy deploy, or a correctly-completed rollback. Do not touch
`factions_live` for this alert — there is nothing to restore, and nothing is
down.** The only thing that failed is a file write under `/var/lib/clan-wars`
(the state file, or `$FAILED_MARKER`) — most likely because step 1's
`install -d -o acab -g acab /var/lib/clan-wars` was skipped or undone (e.g. by
a `sudo mkdir` recreating the directory as root) or the volume is full.

The first two phrases (`state_write`/marker-clear failures on the success
path) only ever mean this. The third — `mark_failed()`'s own alert,
"`could not write $FAILED_MARKER; this deploy will retry in 2 minutes`" — is
reused by three call sites and needs one extra check before you trust it:
it fires right after a **successful** rollback has already put production
back and started it (the database is correctly restored at that point, before
this alert can even fire), but the identical text is also reachable from
*inside* Class 1 (nested in `rollback_abort()`) and Class 2 (nested in both
dump-failure paths) when the marker write fails there too. So: if this text
is the **only** `CRITICAL` you see — typically right next to a non-`CRITICAL`
`ROLLED BACK` alert — it is this class, standalone, and the database is fine.
If it appears **alongside** a `ROLLBACK FAILED` or a Class 2 alert, that other
alert is what actually happened and drives your recovery; this one only means
the bookkeeping file *also* failed to write, which changes nothing about what
you do, since a human is already needed either way.

The cost of ignoring a standalone one is not data loss: at worst, the timer
sees the same (already-good) tag as "new" again in two minutes and redeploys
it, or retries a tag whose earlier failure was real — a second, needless
outage window, not a corrupted one. Recovery: fix `/var/lib/clan-wars`'s
ownership or free space, then write the missing file by hand as `acab`
(`echo <tag> | sudo -u acab tee /var/lib/clan-wars/deployed-tag`, or
`sudo -u acab rm /var/lib/clan-wars/deployed-tag.failed` if that's the one
that wouldn't write or clear).

### The `FAILED-<tag>` marker

A **non-`CRITICAL`** failure — the ordinary "this release is broken" case,
where the automatic rollback succeeded and the previous release is back up
and healthy — still leaves a marker at `/var/lib/clan-wars/deployed-tag.failed`,
containing the tag that failed. ⚠️ This is deliberate, not a bug: without it,
the timer would see the same newest tag again in two minutes and repeat the
entire stop/dump/migrate/start outage for the same broken release, every two
minutes, forever. The script refuses to retry a tag while this marker names
it — the alert says `BLOCKED`, not `CRITICAL`, because production is fine;
only the retry is refused.

⚠️ **A `BLOCKED` state does not go away on its own, and neither does the
refusal.** The script alerts **once** per condition and then refuses silently
every two minutes until a human clears it: the failure marker's alert is keyed
on the tag it names (`deployed-tag.failed.notified`), and the dirty-tree
refusal's on a checksum of `git status --porcelain`
(`deployed-tag.dirty-notified`). That suppression exists because the
alternative — 720 identical Discord messages a day — buries the `CRITICAL`s
this whole design depends on somebody reading. The consequence for the
operator: **one `BLOCKED` message means the deploys have stopped, not that one
poll was skipped.** There will be no reminder. A release sitting undeployed
with no further alerts is the expected appearance of this state, so treat the
first message as the whole notice. Both sidecars are removed whenever the thing
they describe is — on a successful deploy, on a fresh failure, and when the
tree stops being dirty — so the next genuine event always alerts. Clearing the
files by hand is never necessary and never harmful.

To let it retry (normally: after a fix has been pushed and re-tagged, or once
you've confirmed the earlier failure was transient):

    sudo -u acab rm /var/lib/clan-wars/deployed-tag.failed

A healthy deploy of the *same* tag clears this marker itself on success — you
only ever need to remove it by hand after a failure that will not resolve on
its own, or to force a documented retry of a tag you've decided is actually
fine.
