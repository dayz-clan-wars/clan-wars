# Design: single-host deployment on `regime` — 2026-09-03

**Shipping:** the whole stack — Postgres, ingest worker, web app and bot — onto the
machine that already serves `dayzonelife.com`, `factory.eli5hq.com`, `manicdotes.com` and
`regime.fi` behind a single system nginx. Caddy is removed from the repository. The bot
gains a systemd unit.

This design exists because the premise the previous deploy documents were written against
turned out to be false. They describe a **VPS**, separate from the machine holding
`factions_live`. There is no such machine.

---

## 1. What is actually true of this host

Established by inspection on 2026-09-03, not assumed:

| Fact | Evidence | Consequence |
|---|---|---|
| No `factions_live` exists anywhere here | `docker volume ls` has no `factions-pg`; `docker ps -a` and `docker images` are both empty | This is a **first** deploy, not a migration. All 20 journal entries apply. |
| `dayzclanwars.com` → `187.77.9.189` = this host's egress IP | `dig +short`, `curl https://api.ipify.org` | The Caddyfile's "DNS points at the VPS, not here" warning is stale and inverted. |
| Inbound :80 works from the internet | `curl -o /dev/null -w '%{http_code}' http://dayzclanwars.com/` → `301` | ACME HTTP-01 is viable. |
| nginx 1.24.0 owns `0.0.0.0:80` and `:443` | `ss -tlnp` | ⚠️ Caddy can never bind here. Not "should not" — cannot. |
| Four vhosts, all certbot-managed, `certbot.timer` active | `/etc/nginx/sites-enabled/`, `systemctl list-timers` | A new cert is routine, not a new mechanism. |
| :3000, :3001, :3010, :3011 are taken | `ss -tlnp` | The web container needs a port none of the neighbours want. |
| ~15 dayzonelife.com services match `src/main.ts` | `ps ax \| grep src/main.ts` | ⚠️ See §5. This is the dangerous one. |
| :5432 is a native postgres belonging to another project | `ss -tlnp` | Unchanged. Clan Wars stays on 5434 as CLAUDE.md requires. |

### The corrections this forces in CLAUDE.md

Four statements in CLAUDE.md are now false, and each one is false in a direction that
causes damage rather than confusion:

1. The Caddy/DNS hazard note in "Running things" describes a rate-limit risk that cannot
   occur (Caddy is gone) and misstates where DNS points.
2. `pkill -f "src/main.ts"` — §5.
3. "**⚠️ `docker-compose.yml` describes services the VPS must not start**" names a machine
   that does not exist. The real rule is the inverse: this host must not start `caddy`,
   and after this design it cannot, because `caddy` will not be in the file.
4. "Current state — 2026-09-03" describes dormancy, rebind and the feed as *deployed*,
   with migrations applied to `factions_live` and faction `COK` live. None of that is
   true of any running system. It is a record of a deployment that no longer exists.

⚠️ Item 4 matters beyond tidiness: the read-only acceptance check at the end of CLAUDE.md
is written to be run *before any future dormancy change*, and on a fresh database it will
return zero rows. A zero-row result must be read as "nothing deployed yet", not as
"nothing will transition" — those are the same output with opposite meanings.

---

## 2. Topology

```
internet :443 ──▶ nginx (system, host) ──▶ 127.0.0.1:3020 ──▶ web container :3000
                    │
                    ├── dayzonelife.com   → 127.0.0.1:3010   (untouched)
                    ├── factory.eli5hq.com→ 127.0.0.1:3100   (untouched)
                    ├── manicdotes.com                        (untouched)
                    └── regime.fi                             (untouched)

docker compose:  postgres (127.0.0.1:5434) ◀── ingest-worker
                                            ◀── bot (systemd, on the host)
```

**Why nginx proxies to a container rather than running Next under pm2 like its
neighbours.** The web image was deliberately verified on both `linux/amd64` and
`linux/arm64` on 2026-09-03, and `apps/web/test/smoke.test.ts` pins that the app imports
no database package and reads no `DATABASE_URL`. On this host that test guards something
it did not previously guard: `factions_live` is now on the *same machine* as the web app,
so the isolation the test asserts is no longer also enforced by a network boundary. The
container is what puts a boundary back. Running the web app as a bare host process would
place a Next.js server one `DATABASE_URL` away from production data, with only a unit
test between them.

**Port 3020.** Free, and deliberately outside the 3000–3011 band the other projects grow
into. Published as `127.0.0.1:3020:3000`, never `0.0.0.0` — ⚠️ binding all interfaces
would serve the site over plain HTTP alongside the TLS one, which is the exact hazard the
existing compose comment cites as its reason for publishing no port at all.

`apps/web/Dockerfile` already sets `ENV HOSTNAME=0.0.0.0`, so the standalone server binds
all interfaces *inside* the container and the loopback publish works. Without that line
Next would bind only the container IP and the published port would connect to nothing.

---

## 3. Removing Caddy

`caddy` leaves `docker-compose.yml`; `Caddyfile` is deleted; the `caddy-data` and
`caddy-config` volumes go with them.

The alternative — keeping the service and relying on always naming services on the
command line — was rejected. The compose file already carries a comment instructing the
reader to name services, and that comment was written for a machine that does not exist.
A `caddy` service in a file that `docker compose up -d` reads is a request for :80 on a
host where nginx holds :80: the failure is a container in a restart loop and a site that
looks deployed. House rule: two statements of one fact will drift. Delete the fact that
is no longer true.

What Caddy did that nginx must now do explicitly, since it is no longer automatic:

| Caddy behaviour | nginx replacement |
|---|---|
| ACME issuance + renewal | `certbot certonly --nginx`, renewed by the existing `certbot.timer` |
| `encode gzip` | `gzip on` in the vhost |
| `header @flags Cache-Control` for `/flags/*` | `location /flags/ { add_header ... }` |
| apex + www on one block | separate `www` → apex 301, matching `dayzonelife.com`'s vhost |

⚠️ The `/flags/*` cache header is not cosmetic. `FLAG_IMAGE_BASE_URL=https://dayzclanwars.com`
means Discord fetches the 33 flag images from this vhost to build feed embed thumbnails.
Dropping the header does not break embeds, but it does move that traffic from Discord's
CDN onto this host on every post.

The vhost is checked into `deploy/nginx/dayzclanwars.com.conf` in this repo and symlinked
from `/etc/nginx/sites-enabled/`, matching how `dayzonelife.com`'s vhost is version
controlled. ⚠️ A vhost that exists only in `/etc/nginx` is a configuration whose only copy
is on the machine it configures.

---

## 4. TLS bootstrap ordering

⚠️ `nginx -t` fails if `ssl_certificate` names a file that does not exist, so the final
vhost cannot be installed before the cert exists, and the cert cannot be obtained without
nginx answering the challenge. Two steps, in this order — the same two the
`dayzonelife.com` vhost's header comment records:

1. **Bootstrap vhost**: `listen 80` only, `server_name dayzclanwars.com
   www.dayzclanwars.com`. `nginx -t` → reload. Its only job is to give certbot's `nginx`
   authenticator a server block matching the names.
2. `certbot certonly --nginx -d dayzclanwars.com -d www.dayzclanwars.com`, after a
   `--dry-run` against the staging server. ⚠️ All four existing certs on this host use
   `authenticator = nginx` (`/etc/letsencrypt/renewal/*.conf`), so this follows the
   established convention and the active `certbot.timer` already renews it. The dry run
   has separate, generous rate limits — it is what makes a mistake here cheap.
3. **Final vhost** replaces it: :80 → 301, www :443 → 301 to apex, apex :443 serving the
   proxy. `nginx -t` → reload.

⚠️ Every reload in this sequence is a reload of the nginx serving four other production
sites. `nginx -t` before each one is not optional, and `reload` (not `restart`) keeps
existing connections alive.

**Hardening, as its own step:** today `dayzclanwars.com` returns a 301 to
`dayzonelife.com`, because nginx has no `default_server` and the first-loaded :80 block
wins an unmatched `Host`. That is a cross-site leak between unrelated properties. Add a
`default_server` block returning `444` before adding the new vhost, so the new name is
served by intent rather than by file load order.

---

## 5. The bot, and the reason it gets a systemd unit

CLAUDE.md's procedure for the "exactly one bot instance" invariant is:

    ps ax | grep "src/main.ts" | grep -v grep    # confirm zero survivors
    pkill -f "src/main.ts"                       # kill

On this host that check has ~15 permanent false positives and that kill would stop
dayzonelife.com's verifier, api, ingest-worker, projector, granter, rebooter, enforcer,
crier, newsdesk and notifier. The procedure does not merely fail here — it is a
site-outage command that reads like a cleanup command.

⚠️ This invariant is not theoretical. `notifyCompleted` DMs before it marks, which is
correct for one process and at-least-once across two; a duplicate DM reached a real player
on 2026-09-01, and the cause recorded in CLAUDE.md is precisely a `pkill` pattern that
failed to match.

**`clan-wars-bot.service`**, a systemd unit:

- `EnvironmentFile=/opt/clan-wars/.env` — ⚠️ `BOT_FEED_CHANNEL_ID` must come from the
  file. Passing it on a command line turns the feed off at the next restart with nothing
  saying so: rows keep accumulating unposted and the only signal is one warn line.
- `Restart=on-failure`, `WorkingDirectory=/opt/clan-wars`,
  `ExecStart=` the pnpm filter start command.
- `After=docker.service`, and it must not start before Postgres is up and migrated.

Start / stop / check become `systemctl start|stop|is-active clan-wars-bot`. The
single-instance guarantee moves from "a `grep` pattern is precise enough" to "systemd
will not start a second instance of a unit" — and stopping the bot becomes incapable of
touching another project's processes, because the unit's cgroup contains only its own.

⚠️ `Restart=on-failure`, not `always`: a bot that exits deliberately should stay exited.

The unit file lives at `deploy/systemd/clan-wars-bot.service` in the repo and is
symlinked or copied into `/etc/systemd/system/`.

---

## 6. Database bring-up

Fresh, so it is the full sequence, each step verified before the next:

1. `docker compose up -d postgres`. ⚠️ Named. A bare `up -d` after this design would also
   start `ingest-worker` against a database with no schema.
2. `createdb factions_live` — the compose `POSTGRES_DB` is `factions`, and
   `factions_live` is a second database on the same server that nothing creates for you.
3. **Migrations as their own deliberate step**, using the guarded one-off runner recorded
   in `docs/deploy/2026-09-02-dormancy.md`, which refuses any URL not ending in
   `/factions_live`. Expect **20 of 20** journal entries — on an empty
   `drizzle.__drizzle_migrations` the migrator applies every entry, which is the intended
   behaviour here and the one case where "it applied everything" is correct.
   Verify: `select count(*) from drizzle.__drizzle_migrations` → 20.
4. **Register the server.** ⚠️ Nothing creates a `servers` row, and with none the worker
   sweeps nothing and reports no error — the failure is silence.

       pnpm --filter @factions/ingest-worker exec tsx src/register-server.ts \
         --name <name> --map <map> --service-id <n> --offset-ms <n>

   ⚠️ `--offset-ms` has no default by design: a wrong offset stores every timestamp hours
   off while every count-based check stays green. Measured values recorded in the script:
   chernarus `14400000` (+4h), livonia and sakhal `25200000` (+7h). **These four values
   are an input this design cannot supply** — they depend on which Nitrado service is
   being run.
5. `docker compose build web ingest-worker`, then `up -d web ingest-worker` — named.
6. Verify `curl -I http://127.0.0.1:3020` **before** nginx points at it, so a failure is
   diagnosed as an app failure and not as a proxy failure.
7. Bot last, via systemd, after migrations. ⚠️ Old code against new schema and new code
   against old schema both break; the bot must never be the thing that discovers the
   schema state.

**Rollback.** Steps 1–6 are reversible by `docker compose down` plus removing the nginx
symlink and reloading; nothing outside this project's containers and one vhost is
touched. Step 3 is not reversible — but on a fresh database there is nothing to roll back
to, which is the one advantage of having no data yet.

---

## 7. What is explicitly not in scope

- Backups of `factions_live`. It will hold real player state within a day of the bot
  starting, and nothing in this design or the repository backs it up. This is a **known
  gap**, called out here so it is a decision rather than an oversight.
- Recovering the faction data described in CLAUDE.md's "Current state". Confirmed
  unrecoverable; the section becomes history.
- Any change to the four existing vhosts beyond adding a `default_server`.
- Monitoring or alerting, including the already-known-open gap that a blocked feed queue
  logs at error level and nothing watches it.

---

## 8. Success criteria

1. `https://dayzclanwars.com` serves the app; `www` 301s to apex; the four existing sites
   still serve, verified by request, not by assumption.
2. `curl -I https://dayzclanwars.com/flags/<one>.png` returns the immutable
   `Cache-Control`.
3. `select count(*) from drizzle.__drizzle_migrations` = 20; one row in `servers`.
4. `systemctl is-active clan-wars-bot` = active; exactly one bot process, confirmed via
   the unit's cgroup (`systemctl status`), not via `ps | grep`.
5. The ingest worker has written rows to `events` within two sweep intervals.
6. `docker ps` shows exactly `postgres`, `ingest-worker`, `web` — and no `caddy`, which
   after this design is not a thing that can be started.
7. The full gate still passes: `TEST_DATABASE_URL=... npx turbo run typecheck test
   --concurrency=1 --force`, **22/22 tasks**, checked by count and not by exit code.
8. CLAUDE.md's four false statements are corrected.
