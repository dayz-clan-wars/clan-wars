# Automatic deployment on release — design

**Status:** approved 2026-09-16, not implemented.

A release tag reaching `main` deploys itself to `regime`: schema, code, host
config and services, with an automatic rollback that restores the database as
well as the code. No human step between `keel:ship` and production.

This is a deliberate reversal of a documented invariant. `CLAUDE.md` has said
since 2026-09-02 that **nothing applies migrations automatically**, and that
line exists because of a real incident — a bot looping on `dormancy tick failed
… column "dormant_since" does not exist` until `0015` was applied by hand. The
decision to automate it anyway was made on 2026-09-16 with that history stated.
What makes it survivable is not optimism about migrations; it is that the
services are **stopped before the dump is taken**, which is what turns rollback
from a data-loss event into an exact restore. See §4.

---

## 1. Scope

In scope: one host (`regime`), one repo (`/opt/clan-wars`), three services
(`clan-wars-bot`, `web`, `ingest-worker`), one database (`factions_live`), and
the nginx/systemd configuration symlinked out of `deploy/`.

Out of scope, deliberately:

- **Multi-host or blue/green.** There is no second machine (`CLAUDE.md`), and
  inventing one is a bigger project than this.
- **Zero-downtime.** Every deploy is a deliberate outage of 1–3 minutes. That
  is the price of the lossless rollback in §4, and it is the right trade for a
  game server's Discord bot.
- **Deploying anything but a tag.** A push to `main` deploys nothing.

## 2. Trigger

A systemd timer polls; nothing reaches in from outside.

    deploy/systemd/clan-wars-deploy.timer     OnUnitActiveSec=2min
    deploy/systemd/clan-wars-deploy.service   Type=oneshot → deploy-release.sh

Pull, not push, and the reasoning is about blast radius rather than
convenience. A push design (GitHub Actions over SSH, or a self-hosted runner)
puts a credential for this host inside a repo that accepts fork pull requests,
on a machine that also serves dayzonelife.com, manicdotes.com and regime.fi.
The worst failure of the pull design is a deploy that happens two minutes late.

The script selects the newest `vX.Y.Z` tag reachable from `origin/main`, by
semver order — **not** by tag creation date, which reorders under
`git fetch --tags` and would happily "deploy" an old tag re-pushed.

State lives at `/var/lib/clan-wars/deployed-tag`, **outside the git tree**.
⚠️ Inside the tree it would be rewritten by the deploy's own `git checkout`,
so a rollback would restore a file claiming the rollback had not happened.

Concurrency: `flock` on `/var/lock/clan-wars-deploy`. A second timer firing
during a slow deploy exits immediately, silently.

## 3. Sequence

### Preflight — no downtime, every abort is free

1. `flock`, else exit 0.
2. `git fetch --tags --prune origin`.
3. Resolve newest semver tag; equal to the state file → exit 0 **silently**.
   ⚠️ No webhook on a no-op: at a 2-minute interval that is 720 messages a day,
   and an alert channel nobody reads is not an alert channel.
4. ⚠️ **Refuse if the working tree is dirty.** An edit on the box is either an
   emergency hotfix or a mistake; both deserve a human, and `git checkout`
   would silently discard either. Alert and exit non-zero.
5. Build `clan-wars-web:<tag>`; record the current image id as the rollback
   target. A failed build aborts with **nothing stopped and nothing changed**.

⚠️ The build is before the stop on purpose. `docker compose build web` is the
longest step, and running it inside the outage window would roughly triple the
downtime for no benefit.

> **Amended 2026-09-16 (final review), after this section was written. ⚠️ Step
> 5 as written above, together with step 9, specifies a Critical defect, and
> this amendment is what corrects the binding document.**
>
> **Build-then-checkout is wrong: it must be checkout-then-build.** Steps 5 and
> 9 put `git checkout <tag>` *after* the build, which means the images are
> built from the tree as it still is — the **previous** release. The deploy
> then migrates the schema forward and ships `web` and `ingest-worker` running
> old code against it: exactly the new-schema/old-code failure of 2026-09-02
> that this design's own §6 calls load-bearing, arrived at automatically and
> invisibly, because old code answers HTTP 200 perfectly happily and the health
> check in §3 step 14 would pass. Implementation caught this and shipped the
> corrected order; the spec is amended to match rather than left specifying the
> defect.
>
> The shipped order is: capture the running image ids → `git checkout <tag>` →
> `pnpm install --frozen-lockfile` → `docker compose build web ingest-worker`
> → dump → migrate. All of it is still before the stop, so the downtime
> argument above is unaffected.
>
> **This makes "nothing changed" false, and that is why a revert exists.** Once
> the checkout has happened, an abort has already rewritten the working tree —
> and with it the live nginx and systemd configuration symlinked out of it (§6)
> — installed the new release's dependencies, and, if the build got that far,
> retagged one or both compose image names onto new code. So every abort from
> the checkout onwards calls `restore_previous_release()`: revert the tree,
> reinstall dependencies at the previous ref, retag both images back, and start
> only the halves whose precondition actually succeeded. "Nothing **stopped**"
> remains true at those aborts; "nothing changed" never was.
>
> Step 5 is also inaccurate in two smaller ways. **Both** services are built,
> not `web` alone — restoring `web` alone would leave `ingest-worker` on the
> new image against the restored old schema, which no health check here can
> see, because the worker serves no HTTP. And no `clan-wars-web:<tag>` image is
> produced: `docker compose build` retags the compose project's own image name,
> which is why the rollback has to *ask* compose what that name is
> (`docker compose config --images`) rather than assume it, and why the
> previously-running image is pinned under a named tag
> (`clan-wars-web:rollback`, `clan-wars-ingest-worker:rollback`) the moment it
> is captured — the build leaves it dangling otherwise, and any
> `docker image prune` on this host would delete the rollback target.
>
> **`pnpm install --frozen-lockfile` is a step this section never mentions and
> needs to.** The bot is not containerised: it runs from this tree against host
> `node_modules`, and nothing else installs them, so a release that adds or
> bumps a dependency would start a bot importing a package that is not there.
> It runs in the preflight (after the checkout, before the build), in
> `restore_previous_release()`'s tree revert, and in the rollback — reverting
> the tree without reverting the dependencies is only half a revert.

### Outage window

6. Stop `clan-wars-bot`, then `web` and `ingest-worker`.
   ⚠️ All three, because all three write to `factions_live` — the bot every
   tick, `web` through `packages/roster`, the worker through `events` and the
   supply upload. A writer left running invalidates §4 entirely.
7. `pg_dump` → `/var/backups/clan-wars/predeploy-<tag>.sql.gz`.
8. **Verify the dump** — gzip integrity plus a plausibility floor on size,
   reusing `deploy/backup/backup-factions-live.sh`'s existing check.
   ⚠️ Abort here, before the schema is touched, if the dump is bad. A rollback
   path you have not verified is not a rollback path, and this is the last
   moment where aborting costs nothing but the downtime already spent.
9. `git checkout <tag>`.
   ⚠️ This is the moment live nginx and systemd configuration changes, because
   `/etc/nginx/sites-enabled/` and `/etc/systemd/system/` are symlinks into
   this tree. See §6.
10. `sudo nginx -t`. Failure → rollback (§4). No reload is attempted on a
    failing config.
11. `pnpm db:migrate --apply --production`. Failure → rollback.
12. `sudo systemctl daemon-reload`; `sudo systemctl reload nginx`.
    ⚠️ `reload`, never `restart` — a restart on a bad config takes down all
    four sites rather than leaving the old config live.
13. Start `web` and `ingest-worker` (new image). **Not the bot yet** — see the
    amendment below.

### Health check — the gate

14. `web`/`ingest-worker`/`postgres` must hold, within a 90-second budget:
    - `docker compose ps` reports `postgres` healthy;
    - `web` returns HTTP 200 on `127.0.0.1:3020`;
    - a `select 1` against `factions_live` succeeds.

    Only once that passes does the script start `clan-wars-bot`, and then wait
    (a further 90-second budget) for its journal to show `bot ready as <tag>` —
    logged once, after Discord login, the first moment the bot genuinely
    exists rather than merely having forked.

⚠️ `systemctl is-active` is **not** a health check, and this is the single
easiest mistake to make here, for either service. `CLAUDE.md` says it outright:
the bot holds no eager database connection and every tick is individually
try/caught, so a bot pointed at a dead database reports `active (running)`
forever with the entire data path down. The HTTP 200 is the load-bearing check
of the three services-first checks, because `web` reads through
`packages/roster` to the database and therefore exercises the whole path
rather than just process liveness.

15. Healthy → write the state file, post success, exit 0.

> **Amended 2026-09-16 (implementation), after this section was written.** The
> sequence above described starting all three services together, then
> checking health. The shipped script (`deploy/deploy-release.sh`) instead
> starts `web` and `ingest-worker`, runs the services-only health check, and
> only starts `clan-wars-bot` after that check passes — with its own
> `bot ready as …` wait gating the final success. See §4's amendment for
> why: the bot is the one writer in the post-start window whose writes a
> rollback cannot discard safely.

> **Amended 2026-09-16 (final review).** Two corrections to this section.
>
> **`bot ready as <tag>` is wrong wherever it appears** — here in step 14, and
> in §4's amendment above. The line is
> `` console.log(`bot ready as ${client.user?.tag}`) `` in
> `apps/bot/src/discord.ts`: that is the bot's **Discord user tag**, the
> account's name, not the release tag. The deploy matches only the fixed
> `bot ready as` prefix, and an operator watching the journal for the release
> tag will not find it. Everything else about the check stands — it is still
> logged once, after login, and is still the first moment the bot genuinely
> exists rather than merely having forked.
>
> **The deploy reconciles `web` and `ingest-worker` only.** It stops, builds,
> retags and starts exactly those two compose services. `postgres` is
> deliberately untouched: it holds `factions_live`, and the rollback's restore
> runs `psql` *inside* that container, so recreating it mid-deploy would be
> both the riskiest possible moment and the one that breaks the undo. A release
> that changes the `postgres` service in `docker-compose.yml` therefore does
> **not** apply — the checkout writes the new definition to disk and nothing
> acts on it, so the running container keeps the old one until a human runs
> `docker compose up -d postgres`. ⚠️ That divergence is silent: nothing
> compares the file against the running container.

## 4. Rollback

Any failure at step 9 or later triggers it, automatically:

    stop all three
    drop and recreate factions_live from predeploy-<tag>.sql.gz
    git checkout <previous tag>
    retag the previous web image
    sudo nginx -t && sudo systemctl reload nginx; sudo systemctl daemon-reload
    start all three
    re-run the health check

**Why this loses no data — at the call sites reached before anything starts,
which is the whole reason those aborts are allowed to be automatic.** The dump
is taken *after* every writer is stopped, and at the `nginx -t failed` and
`migration failed` failure points nothing has started since: no writer exists
between dump and restore, so there is no window in which a player action could
occur and be destroyed. The restore at those two call sites is exact, not
approximate.

In-game activity during the window is not lost either: DayZ keeps writing its
ADM logs on the Nitrado server, and `ingest-worker` re-ingests from its cursor
when it starts. Discord commands issued during the window fail outright. That
is visible downtime, not silent loss, and it is the honest cost.

> **Amended 2026-09-16 (implementation), after this section was written.**
> The paragraph above is too strong: it holds only for the two call sites
> that fail *before any service has been started* (`nginx -t` and the
> migration). The shipped script has two more rollback call sites, both
> reached only after `web` and `ingest-worker` are already running:
>
> - **The services health check fails.** `web` and `ingest-worker` have been
>   up for as long as the check ran (up to 90 s), and the restore discards
>   whatever they wrote in that window. This is accepted, *bounded* damage:
>   `web` writes only on an explicit user action, and `ingest-worker`'s writes
>   are re-ingested from the ADM logs once its cursor rewinds — nothing here
>   is unrecoverable, only re-derivable.
> - **The bot fails to come up.** Same window, plus the time spent waiting on
>   `bot ready as <tag>`. A bot that never reached that line did not tick, so
>   in practice it wrote nothing — but that is an inference from the log, not
>   a guarantee the way "no writer was running" is at the first two sites.
>
> **This is exactly why the bot starts last, after both service checks pass,
> rather than alongside `web` and `ingest-worker` as originally specified in
> §3.** The bot is the one writer in this window that is both high-frequency
> (every tick, ~10 s) and *not* recoverable the way the other two are: for the
> other two, worst case, a fact is momentarily invisible or re-derived. For
> the bot, `notifyCompleted` DMs a player **before** it marks the DM sent —
> the same shape as the 2026-09-01 duplicate-DM incident (CLAUDE.md, "Exactly
> one bot instance may run"). A rollback that rewound the mark without also
> rewinding whatever had already happened over Discord would resend that DM
> automatically, on every restore, forever. Keeping the bot out of the
> pre-health-check window removes that hazard entirely rather than merely
> bounding it — there is no width of "up to 90 s of bot writes" that is safe
> to discard, so the only correct bound is zero.

⚠️ **If the rollback itself fails, stop and stay stopped.** Alert CRITICAL,
leave the services down, and do not retry. A deploy loop that keeps restarting
a broken bot is how the 2026-09-01 duplicate-DM incident reaches a real player;
a stopped bot is a visible outage that a human fixes, which is strictly better
than an automated system thrashing against a database it cannot read.

> **Amended 2026-09-16 (final review).** Three things this section says, or
> leaves out, that the shipped rollback does differently.
>
> **"Retag the previous web image" is both services**, `web` and
> `ingest-worker`. Restoring `web` alone leaves the worker on the new image
> against the restored old schema, and no check in §3 can see it, because the
> worker serves no HTTP. The sequence also re-runs
> `pnpm install --frozen-lockfile` at the previous ref, between the checkout
> and the retag: the bot runs from the tree against host `node_modules`, so a
> tree rolled back without its dependencies starts a bot importing whatever the
> failed release left behind.
>
> **`$FAILED_MARKER` — the most operator-visible behaviour in the system, and
> unmentioned here.** `/var/lib/clan-wars/deployed-tag.failed` names the tag
> whose deploy failed, and the script refuses to deploy that tag again while it
> exists (alerting `BLOCKED`, once, not on every 2-minute poll). Without it a
> failed release would re-enter the whole stop/dump/migrate/rollback outage
> every two minutes, forever. It is written the moment `stop_all` succeeds —
> i.e. as soon as the point of no return is crossed, so that a power loss or an
> OOM kill mid-window still leaves it behind — and cleared unconditionally by a
> deploy that ends healthy. A human removes it to allow a retry.
>
> **A pre-migration abort restores, rather than just reverting.** Every abort
> from the checkout onwards calls `restore_previous_release()`: tree,
> dependencies and both image tags back, then start only the halves whose
> precondition succeeded — and, deliberately, **leave the other half down**,
> saying so at `CRITICAL`. A half-restored host with a service down is a
> visible outage a human recovers from; a half-restored host serving a split
> version looks fine and is silently wrong. It never touches the database: no
> migration has run at those call sites, so restoring would destroy writes for
> no reason.
>
> **`rollback_abort()` is the contract the ⚠️ above describes:** stop
> everything, write the marker, alert `CRITICAL` naming the dump, and **exit
> 2** — never returning, so no caller can fall through into starting production
> on a half-applied migration.

## 5. Alerting

A Discord webhook (`DEPLOY_WEBHOOK_URL` in `.env`), called with `curl`.

⚠️ Deliberately **not** through the bot. The bot is stopped for most of the
deploy and may be the thing that failed; an alert path that shares a failure
domain with the thing it reports on is not an alert path.

Success: one line — tag, duration, whether a migration ran. Failure: the phase
that failed, the rollback's outcome, and the last 20 journal lines.

> **Amended 2026-09-16 (final review).** Two of those promises are not kept,
> and the amendment is to stop promising them rather than to add them.
>
> **No duration** is sent on success: the line is
> `DEPLOYED <tag> is live (host-config=… migrations=…)`. **No journal lines**
> are sent on failure either — an alert carries the phase and the reason and
> nothing else. Both were deliberate at implementation: the webhook body is
> built with `printf` and posted with `curl`, and 20 lines of interpolated
> journal text is the most reliable way to produce a message that Discord
> rejects, silently (`|| true` swallows the failure), at exactly the moment the
> alert matters most. The journal is one `journalctl -u clan-wars-deploy`
> away for anyone the alert reaches.
>
> Alerts are also **suppressed after the first** for the two `BLOCKED`
> refusals, which are conditions only a human clears: repeating them every two
> minutes is 720 messages a day, which buries the `CRITICAL`s. One message
> there means deploys have stopped, not that one poll was skipped.

## 6. Residual risks, stated rather than buried

- **`git checkout` rewrites host configuration for three unrelated sites.**
  `nginx -t` catches syntax, not a vhost that is syntactically valid and wrong
  — a `server_name` collision with dayzonelife.com would pass `-t` and take
  that site over. This was accepted knowingly on 2026-09-16; the alternative
  (refusing to deploy when `deploy/` changes) was offered and declined.
- **An unverified secret-scan finding blocks a release.** `security.yml` runs
  `--results=verified,unknown`, and an unverified hit fails the check — a
  false positive on a docs change is enough. Observed on PR #9 the same day.
- **Migrations are unattended.** `0020` drops columns the running bot selects;
  the stop-first ordering in §3 is what makes that survivable, and it is
  load-bearing rather than tidy.
- **The rollback path is untested until rehearsed.** See §8.

## 7. Repo changes

| File | Change |
|---|---|
| `deploy/deploy-release.sh` | new — the whole sequence |
| `deploy/systemd/clan-wars-deploy.{service,timer}` | new |
| `deploy/README.md` | install steps; the state-file rationale |
| `docs/deploy/2026-09-16-auto-deploy.md` | runbook: install, rehearsal, manual override |
| `CLAUDE.md` | ⚠️ rewrite "Nothing applies migrations automatically" — it becomes false |
| `.env` | `DEPLOY_WEBHOOK_URL` |

> **Amended 2026-09-16 (final review).** Three rows were missing — the whole
> tag-selection half of the system, which is also the only part of it that is
> unit-testable (§8's first bullet):
>
> | File | Change |
> |---|---|
> | `packages/deploy/` | new — semver tag selection and changed-paths classification, with its tests |
> | `scripts/deploy-select.ts` | new — the CLI the script shells out to; prints the plan as JSON |
> | `package.json` (root) | new `deploy:select` script, and `@factions/deploy` as a dependency |

## 8. Testing

Honest about what is and is not provable:

- **Unit-testable, and tested:** semver tag selection (including an old tag
  re-pushed, a non-semver tag, a tag not on `main`), dirty-tree refusal,
  no-op detection, and the changed-paths classification. These are pure
  functions over strings and are where the interesting bugs live.
- **`--dry-run`:** prints every command it would run, executes none. The
  reviewable artifact.
- **First live exercise on a no-op release:** tag a commit that changes
  nothing, so the full path — stop, dump, checkout, migrate, start, health
  check — runs with nothing at stake.
- **Rehearse the rollback deliberately, once, while watching.** Cut a tag with
  a deliberately failing health check and confirm the database, the code and
  the image all come back. ⚠️ Until this is done, the rollback is a design,
  not a capability, and it should not be described as one.

> **Amended 2026-09-16 (final review).** The bullet above is not sufficient on
> its own, and the runbook adds a third rehearsal accordingly. "The database
> came back" has to be **row counts across the restore**, not the site
> answering and the bot being up: `psql` reading a dump from stdin exits 0 even
> when individual `COPY` blocks fail, so a half-restored `factions_live` serves
> HTTP 200, satisfies `select 1`, and lets the bot start. Counting `factions`,
> `faction_members`, `identity_links` and `faction_events` before and after is
> the only check here that can tell the two apart — and it is what proves the
> restore's `-v ON_ERROR_STOP=1` does its job on this host.
>
> The first bullet's "and tested" also covers a package this section's original
> §7 never listed: `packages/deploy`. See §7's amendment.
